// ============================================================
//   Garuda Express v5 — Vercel Serverless API + Vercel KV
//   Data persists across cold starts via Redis (Vercel KV)
// ============================================================
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const multer  = require('multer');

const app = express();

// ── Upstash Redis with in-memory fallback
let _redis = null;
try {
  const { Redis } = require('@upstash/redis');
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
} catch(e) {}
const mem = {};
const useKV = () => !!_redis;
const db = {
  get:  async k     => useKV() ? _redis.get(k)       : (mem[k] ?? null),
  set:  async (k,v) => useKV() ? _redis.set(k,v)     : (mem[k]=v),
  del:  async k     => useKV() ? _redis.del(k)        : (delete mem[k]),
  keys: async pat   => {
    if (useKV()) return _redis.keys(pat);
    const pre = pat.replace('*','');
    return Object.keys(mem).filter(k => k.startsWith(pre));
  }
};

const CACHE_TTL = 5 * 60 * 1000;
const ADMIN_USER  = process.env.ADMIN_USER  || 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASS  || 'garuda2024';
const PORTAL_USER = process.env.PORTAL_USER || 'portal';
const PORTAL_PASS = process.env.PORTAL_PASS || 'garuda2024';
const SESSION_TTL = 8 * 60 * 60 * 1000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024 } });

// ── Key schema
const K = {
  ship:    ge  => `ship:${ge}`,
  ships:   ()  => 'ship:*',
  counter: ()  => 'ge:counter',
  cache:   ge  => `cache:${ge}`,
  sess:    t   => `sess:${t}`,
};

// ── Shipment helpers
const getShip    = async ge  => db.get(K.ship(ge));
const saveShip   = async row => db.set(K.ship(row.ge_tracking_number), row);
const delShip    = async ge  => { await db.del(K.ship(ge)); await db.del(K.cache(ge)); };
const allShips   = async ()  => {
  const keys = await db.keys(K.ships());
  if (!keys || !keys.length) return [];
  const rows = await Promise.all(keys.map(k => db.get(k)));
  return rows.filter(Boolean).sort((a,b) => (b.id||0)-(a.id||0));
};
const nextId     = async ()  => {
  let n = parseInt(await db.get(K.counter()) || 0) + 1;
  await db.set(K.counter(), n); return n;
};
const nextGE     = async ()  => {
  const n = await nextId();
  return `GE-${new Date().getFullYear()}-${String(n).padStart(5,'0')}`;
};
const getStats   = async ()  => {
  const all = await allShips(), today = new Date().toISOString().slice(0,10);
  return { total:all.length, dhl:all.filter(s=>s.carrier==='DHL').length, ups:all.filter(s=>s.carrier==='UPS').length, fedex:all.filter(s=>s.carrier==='FEDEX').length, today:all.filter(s=>s.created_at.startsWith(today)).length };
};

// ── Session helpers
const getSess  = async t   => db.get(K.sess(t));
const saveSess = async (t,d)=> db.set(K.sess(t), d);
const delSess  = async t   => db.del(K.sess(t));

// ── Cache
const getCached = async ge => {
  const c = await db.get(K.cache(ge));
  if (!c) return null;
  if (Date.now()-c.t > CACHE_TTL) { await db.del(K.cache(ge)); return null; }
  return c.d;
};
const setCache = async (ge,data) => db.set(K.cache(ge), { d:data, t:Date.now() });

// ── Auth middleware
const requireAuth = async (req,res,next) => {
  const s = await getSess(req.headers['x-admin-token']);
  if (!s || Date.now()>s.expiry) return res.status(401).json({ success:false, error:'Unauthorized' });
  req.admin = s.username; next();
};
const requirePortal = async (req,res,next) => {
  const s = await getSess(req.headers['x-admin-token']||req.query.token);
  if (!s || Date.now()>s.expiry) return res.status(401).json({ success:false, error:'Unauthorized' });
  next();
};

// ── Login
app.post('/api/admin/login', async (req,res) => {
  const {username,password} = req.body||{};
  if (username!==ADMIN_USER||password!==ADMIN_PASS) return res.status(401).json({success:false,error:'Invalid credentials'});
  const token = crypto.randomBytes(32).toString('hex');
  await saveSess(token, {username, expiry:Date.now()+SESSION_TTL});
  res.json({success:true, token});
});
app.post('/api/admin/logout', requireAuth, async (req,res) => {
  await delSess(req.headers['x-admin-token']); res.json({success:true});
});
app.get('/api/admin/me', requireAuth, (req,res) => res.json({success:true, username:req.admin}));
app.post('/api/portal/login', async (req,res) => {
  const {username,password} = req.body||{};
  const ok = (username===PORTAL_USER&&password===PORTAL_PASS)||(username===ADMIN_USER&&password===ADMIN_PASS);
  if (!ok) return res.status(401).json({success:false,error:'Invalid credentials'});
  const token = crypto.randomBytes(32).toString('hex');
  await saveSess(token, {username, expiry:Date.now()+SESSION_TTL});
  res.json({success:true, token});
});

// ── HTTP helper
function httpReq(opts, body=null) {
  return new Promise((res,rej) => {
    const mod = opts.protocol==='http:' ? http : https;
    const r = mod.request(opts, resp => {
      const ch=[]; resp.on('data',c=>ch.push(c)); resp.on('end',()=>res({status:resp.statusCode,body:Buffer.concat(ch).toString()})); resp.on('error',rej);
    });
    r.setTimeout(opts.timeout||20000, ()=>r.destroy(new Error('timeout'))); r.on('error',rej);
    if (body) r.write(typeof body==='string'?body:JSON.stringify(body)); r.end();
  });
}
const tokCache = {};
async function getCachedTok(key, fn) {
  const c=tokCache[key]; if(c&&Date.now()<c.e-60000) return c.t;
  const r=await fn(); tokCache[key]={t:r.token,e:Date.now()+r.expiresIn*1000}; return r.token;
}

// ── Utils
const clean = s => s ? s.replace(/\s+/g,' ').trim().substring(0,120) : '';
function normStatus(s) {
  if (!s) return 'Pending';
  const l=s.toLowerCase();
  if (l.includes('delivered'))                                              return 'Delivered';
  if (l.includes('out for delivery'))                                       return 'Out for Delivery';
  if (l.includes('transit')||l.includes('departed')||l.includes('arrived'))return 'In Transit';
  if (l.includes('picked up'))                                              return 'Picked Up';
  if (l.includes('customs')||l.includes('clearance'))                      return 'Customs Clearance';
  if (l.includes('exception')||l.includes('failed')||l.includes('attempt'))return 'Exception';
  if (l.includes('label created'))                                          return 'Label Created';
  return s.length>60?s.substring(0,60):s;
}
const dedup = evts => { const s=new Set(); return evts.filter(e=>{const k=`${e.status}|${e.location}`;if(s.has(k))return false;s.add(k);return true}).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)); };
const errRes = (c,cn,tn,msg) => ({carrier:c,carrierName:cn,trackingNumber:tn,currentStatus:'Unavailable',origin:'',destination:'',serviceType:'',events:[],fetchedAt:new Date().toISOString(),isValid:false,error:msg});

// ── 17track
async function track17(tn, carrier, carrierName) {
  const KEY17 = process.env.TRACK17_API_KEY;
  if (KEY17 && KEY17!=='your_17track_api_key_here') {
    try {
      const codes={DHL:2,FEDEX:100002,UPS:100003};
      const rb = JSON.stringify([{number:tn,carrier:codes[carrier]||0}]);
      await httpReq({hostname:'api.17track.net',path:'/track/v2.2/register',method:'POST',timeout:10000,headers:{'17token':KEY17,'Content-Type':'application/json','Content-Length':Buffer.byteLength(rb)}},rb);
      await new Promise(r=>setTimeout(r,1500));
      const gb = JSON.stringify([{number:tn}]);
      const gr = await httpReq({hostname:'api.17track.net',path:'/track/v2.2/gettrackinfo',method:'POST',timeout:15000,headers:{'17token':KEY17,'Content-Type':'application/json','Content-Length':Buffer.byteLength(gb)}},gb);
      if (gr.status===200) {
        const p=JSON.parse(gr.body), track=p?.data?.accepted?.[0]?.track;
        if (track?.z2?.length>0) {
          const events=track.z2.map(e=>({timestamp:e.a?new Date(e.a).toISOString():new Date().toISOString(),status:clean(e.z||e.d||''),location:clean(e.c||'')})).filter(e=>e.status);
          if (events.length>0) return {carrier,carrierName,trackingNumber:tn,currentStatus:normStatus(track.e||events[0].status),origin:clean(track.o||''),destination:clean(track.d||''),serviceType:carrierName,events:dedup(events),fetchedAt:new Date().toISOString(),isValid:true,source:'17track'};
        }
        if (p?.data?.accepted?.[0]) return {carrier,carrierName,trackingNumber:tn,currentStatus:'Registered / Pending',origin:'',destination:'',serviceType:carrierName,events:[{timestamp:new Date().toISOString(),status:'Shipment registered — tracking will appear once carrier scans the package.',location:''}],fetchedAt:new Date().toISOString(),isValid:true,source:'17track-registered'};
        const rej=p?.data?.rejected?.[0];
        if (rej) return errRes(carrier,carrierName,tn,`17track: ${rej.error?.message||'Not found'}`);
      }
    } catch(e) { console.error('[17track]',e.message); }
  }
  return errRes(carrier,carrierName,tn,'Tracking unavailable. Set TRACK17_API_KEY in Vercel environment variables.');
}

// ── DHL
async function trackDHL(tn) {
  const k=process.env.DHL_API_KEY;
  if (k&&!['demo-key','your_dhl_api_key_here'].includes(k)) {
    try {
      const r=await httpReq({hostname:'api-eu.dhl.com',path:`/track/shipments?trackingNumber=${encodeURIComponent(tn)}`,method:'GET',timeout:15000,headers:{'DHL-API-Key':k,'Accept':'application/json'}});
      if (r.status===200) { const s=JSON.parse(r.body)?.shipments?.[0]; if(s?.events?.length>0){const ev=s.events.map(e=>({timestamp:e.timestamp||new Date().toISOString(),status:clean(e.description||''),location:clean([e.location?.address?.addressLocality,e.location?.address?.countryCode].filter(Boolean).join(', '))})).filter(e=>e.status); if(ev.length>0) return {carrier:'DHL',carrierName:'DHL Express',trackingNumber:tn,currentStatus:normStatus(s.status?.description||ev[0].status),origin:clean(s.origin?.address?.addressLocality||''),destination:clean(s.destination?.address?.addressLocality||''),serviceType:'DHL Express',events:dedup(ev),fetchedAt:new Date().toISOString(),isValid:true,source:'dhl-api'}; } }
    } catch(e){console.log('[DHL]',e.message);}
  }
  return track17(tn,'DHL','DHL Express');
}

// ── FedEx
async function getFedExTok() {
  const k=process.env.FEDEX_API_KEY,s=process.env.FEDEX_API_SECRET;
  if(!k||k==='your_fedex_api_key_here') throw new Error('FedEx keys missing');
  return getCachedTok('fedex',async()=>{const b=`grant_type=client_credentials&client_id=${encodeURIComponent(k)}&client_secret=${encodeURIComponent(s)}`;const r=await httpReq({hostname:'apis.fedex.com',path:'/oauth/token',method:'POST',timeout:15000,headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(b)}},b);if(r.status!==200)throw new Error(`FedEx OAuth ${r.status}`);const d=JSON.parse(r.body);return{token:d.access_token,expiresIn:d.expires_in||3600};});
}
async function trackFedEx(tn) {
  const k=process.env.FEDEX_API_KEY;
  if(k&&k!=='your_fedex_api_key_here'){try{const tok=await getFedExTok(),pl=JSON.stringify({trackingInfo:[{trackingNumberInfo:{trackingNumber:tn}}],includeDetailedScans:true});const r=await httpReq({hostname:'apis.fedex.com',path:'/track/v1/trackingnumbers',method:'POST',timeout:20000,headers:{'Content-Type':'application/json','Authorization':`Bearer ${tok}`,'Content-Length':Buffer.byteLength(pl),'x-locale':'en_US'}},pl);if(r.status===200){const res=JSON.parse(r.body)?.output?.completeTrackResults?.[0]?.trackResults?.[0];if(res&&!res.error){const ev=(res.scanEvents||[]).map(e=>({timestamp:e.date?new Date(e.date).toISOString():new Date().toISOString(),status:clean(e.eventDescription||''),location:clean([e.scanLocation?.city,e.scanLocation?.stateOrProvinceCode,e.scanLocation?.countryCode].filter(Boolean).join(', '))})).filter(e=>e.status);if(ev.length>0){const sh=res.shipperInformation?.address,re=res.recipientInformation?.address;return{carrier:'FEDEX',carrierName:'FedEx',trackingNumber:tn,currentStatus:normStatus(res.latestStatusDetail?.description||ev[0].status),origin:clean([sh?.city,sh?.countryCode].filter(Boolean).join(', ')),destination:clean([re?.city,re?.countryCode].filter(Boolean).join(', ')),serviceType:clean(res.serviceDetail?.description||'FedEx Express'),events:dedup(ev),fetchedAt:new Date().toISOString(),isValid:true,source:'fedex-api'};}}}}catch(e){console.log('[FedEx]',e.message);}}
  return track17(tn,'FEDEX','FedEx');
}

// ── UPS
async function getUPSTok() {
  const id=process.env.UPS_CLIENT_ID,s=process.env.UPS_CLIENT_SECRET;
  if(!id||id==='your_ups_client_id_here') throw new Error('UPS keys missing');
  return getCachedTok('ups',async()=>{const cr=Buffer.from(`${id}:${s}`).toString('base64'),b='grant_type=client_credentials';const r=await httpReq({hostname:'onlinetools.ups.com',path:'/security/v1/oauth/token',method:'POST',timeout:15000,headers:{'Content-Type':'application/x-www-form-urlencoded','Authorization':`Basic ${cr}`,'x-merchant-id':'string','Content-Length':Buffer.byteLength(b)}},b);if(r.status!==200)throw new Error(`UPS OAuth ${r.status}`);const d=JSON.parse(r.body);return{token:d.access_token,expiresIn:d.expires_in||14399};});
}
async function trackUPS(tn) {
  const id=process.env.UPS_CLIENT_ID;
  if(id&&id!=='your_ups_client_id_here'){try{const tok=await getUPSTok();const r=await httpReq({hostname:'onlinetools.ups.com',path:`/api/track/v1/details/${encodeURIComponent(tn)}?locale=en_US&returnSignature=false`,method:'GET',timeout:20000,headers:{'Authorization':`Bearer ${tok}`,'transId':String(Date.now()),'transactionSrc':'garuda-express','Accept':'application/json'}});if(r.status===200){const j=JSON.parse(r.body),ship=j?.trackResponse?.shipment?.[0],pkg=ship?.package?.[0];if(pkg){const ev=(pkg.activity||[]).map(a=>{const d=a.date||'',t=a.time||'';let ts;try{ts=d&&t?new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}Z`).toISOString():new Date().toISOString();}catch{ts=new Date().toISOString();}return{timestamp:ts,status:clean(a.status?.description||''),location:clean([a.location?.address?.city,a.location?.address?.country].filter(Boolean).join(', '))};}).filter(e=>e.status);if(ev.length>0)return{carrier:'UPS',carrierName:'UPS',trackingNumber:tn,currentStatus:normStatus(pkg.currentStatus?.description||ev[0].status),origin:clean([ship.shipFrom?.address?.city].filter(Boolean).join(', ')),destination:clean([ship.shipTo?.address?.city].filter(Boolean).join(', ')),serviceType:clean(ship.service?.description||'UPS'),events:dedup(ev),fetchedAt:new Date().toISOString(),isValid:true,source:'ups-api'};}}}catch(e){console.log('[UPS]',e.message);}}
  return track17(tn,'UPS','UPS');
}

async function doTrack(carrier,tn) {
  const c=(carrier||'').toUpperCase().trim();
  if(c==='DHL') return trackDHL(tn);
  if(c==='UPS') return trackUPS(tn);
  if(c==='FEDEX') return trackFedEx(tn);
  return track17(tn,c,c);
}

const r2s = r => ({geTrackingNumber:r.ge_tracking_number,carrierTrackingNumber:r.carrier_tracking_number,carrier:r.carrier,customerName:r.customer_name,fromName:r.from_name||'',fromAddress:r.from_address,toName:r.to_name||'',toAddress:r.to_address,serviceType:r.service_type,weight:r.weight,dimensions:r.dimensions,pieces:r.pieces||'',description:r.description||'',shipDate:r.ship_date||'',createdAt:r.created_at,updatedAt:r.updated_at});

// ── Public tracking
app.get('/api/track/:ge', async (req,res) => {
  const ge=req.params.ge.toUpperCase(), row=await getShip(ge);
  if (!row) return res.json({success:false,error:`No shipment found for: ${ge}`});
  const cached=await getCached(ge);
  if (cached) return res.json({success:true,shipment:cached,cached:true});
  try {
    const td=await doTrack(row.carrier,row.carrier_tracking_number);
    if (!td.isValid) return res.json({success:false,error:td.error,carrier:row.carrier,carrierTrackingNumber:row.carrier_tracking_number});
    const ship={geTrackingNumber:row.ge_tracking_number,carrierTrackingNumber:row.carrier_tracking_number,carrier:row.carrier,carrierName:td.carrierName,customerName:row.customer_name,fromAddress:row.from_address,toAddress:row.to_address,currentStatus:td.currentStatus,origin:td.origin||row.from_address,destination:td.destination||row.to_address,serviceType:td.serviceType||row.service_type,trackingData:td,createdAt:row.created_at,fetchedAt:td.fetchedAt,source:td.source};
    await setCache(ge,ship); res.json({success:true,shipment:ship});
  } catch(e){res.json({success:false,error:'Tracking failed.'});}
});

// ── API keys status
app.get('/api/admin/api-keys-status', requireAuth, (req,res) => {
  const chk=(k,ph)=>!!(process.env[k]&&process.env[k]!==ph);
  res.json({success:true,status:{DHL:{configured:chk('DHL_API_KEY','your_dhl_api_key_here')},UPS:{configured:chk('UPS_CLIENT_ID','your_ups_client_id_here')},FEDEX:{configured:chk('FEDEX_API_KEY','your_fedex_api_key_here')},TRACK17:{configured:chk('TRACK17_API_KEY','your_17track_api_key_here')},KV:{configured:!!process.env.KV_REST_API_URL,note:'Vercel KV persistence'}},chain:'Carrier API → 17track → error'});
});

// ── Shipments CRUD
app.get('/api/shipments', requireAuth, async (req,res) => {
  const c=(req.query.carrier||'').toUpperCase();
  let list=await allShips();
  if(c&&c!=='ALL') list=list.filter(s=>s.carrier===c);
  res.json({success:true,shipments:list.map(r2s),stats:await getStats()});
});

app.post('/api/shipments', requireAuth, async (req,res) => {
  const {carrier,carrierTrackingNumber,geTrackingNumber,customerName,fromName,fromAddress,toName,toAddress,serviceType,weight,dimensions,pieces,description,shipDate}=req.body||{};
  if(!carrier||!carrierTrackingNumber||!customerName) return res.json({success:false,error:'Missing required fields'});
  const c=carrier.toUpperCase();
  if(!['DHL','UPS','FEDEX'].includes(c)) return res.json({success:false,error:'Invalid carrier'});
  const ge=(geTrackingNumber||await nextGE()).toUpperCase();
  if(await getShip(ge)) return res.json({success:false,error:`${ge} already exists`});
  const now=new Date().toISOString(), id=await nextId();
  const row={id,ge_tracking_number:ge,carrier_tracking_number:carrierTrackingNumber.trim(),carrier:c,customer_name:customerName.trim(),from_name:fromName||'',from_address:fromAddress||'',to_name:toName||'',to_address:toAddress||'',service_type:serviceType||'',weight:weight||'',dimensions:dimensions||'',pieces:pieces||'',description:description||'',ship_date:shipDate||'',created_at:now,updated_at:now};
  await saveShip(row); res.json({success:true,shipment:r2s(row)});
});

app.get('/api/shipments/:ge', requireAuth, async (req,res) => {
  const row=await getShip(req.params.ge.toUpperCase());
  if(!row) return res.json({success:false,error:'Not found'});
  res.json({success:true,shipment:r2s(row)});
});

app.put('/api/shipments/:ge', requireAuth, async (req,res) => {
  const ge=req.params.ge.toUpperCase(), row=await getShip(ge);
  if(!row) return res.json({success:false,error:'Not found'});
  const {customerName,fromName,fromAddress,toName,toAddress,serviceType,weight,dimensions,pieces,description,shipDate,carrierTrackingNumber:ctn}=req.body||{};
  Object.assign(row,{customer_name:customerName||row.customer_name,carrier_tracking_number:ctn||row.carrier_tracking_number,from_name:fromName||row.from_name,from_address:fromAddress||row.from_address,to_name:toName||row.to_name,to_address:toAddress||row.to_address,service_type:serviceType||row.service_type,weight:weight||row.weight,dimensions:dimensions||row.dimensions,pieces:pieces!==undefined?pieces:row.pieces||'',description:description||row.description,ship_date:shipDate||row.ship_date,updated_at:new Date().toISOString()});
  await saveShip(row); await db.del(K.cache(ge));
  res.json({success:true,shipment:r2s(row)});
});

app.delete('/api/shipments/:ge', requireAuth, async (req,res) => {
  const ge=req.params.ge.toUpperCase();
  if(!await getShip(ge)) return res.json({success:false,error:'Not found'});
  await delShip(ge); res.json({success:true});
});

app.get('/api/generate-ge-number', requireAuth, async (req,res) => res.json({success:true,geNumber:await nextGE()}));
app.post('/api/shipments/:ge/refresh', requireAuth, async (req,res) => { await db.del(K.cache(req.params.ge.toUpperCase())); res.json({success:true}); });
app.post('/api/clear-all', requireAuth, async (req,res) => {
  const all=await allShips();
  await Promise.all(all.map(s=>delShip(s.ge_tracking_number)));
  await db.set(K.counter(),0);
  res.json({success:true,message:`Cleared ${all.length} shipments`});
});

app.post('/api/test-carrier', requireAuth, async (req,res) => {
  const {carrier,trackingNumber}=req.body||{};
  if(!carrier||!trackingNumber) return res.json({success:false,error:'carrier and trackingNumber required'});
  const t0=Date.now();
  try{const d=await doTrack(carrier.toUpperCase(),trackingNumber);res.json({success:d.isValid,data:d,eventsFound:d.events?.length||0,duration:`${Date.now()-t0}ms`,source:d.source||'unknown'});}
  catch(e){res.json({success:false,error:e.message});}
});

app.post('/api/detect-carrier', (req,res) => {
  const n=(req.body?.trackingNumber||'').trim().toUpperCase();
  let carrier=null;
  if(/^1Z[A-Z0-9]{16}$/i.test(n)) carrier='UPS';
  else if(/^\d{12,15}$/.test(n)) carrier='FEDEX';
  else if(/^(\d{10,12}|[A-Z]{4}\d+|GM\d+|JD\d+)$/i.test(n)) carrier='DHL';
  res.json({success:!!carrier,carrier});
});

// ── Portal upload
app.post('/api/portal/upload', requirePortal, (req,res) => {
  upload.single('waybill')(req,res,async err=>{
    if(err) return res.json({success:false,error:err.message});
    if(!req.file) return res.json({success:false,error:'No file uploaded'});
    try{
      const parsed=parseWaybill(req.file.buffer), carrier=parsed.carrier||(req.body.carrier||'DHL').toUpperCase();
      const ge=await nextGE(), now=new Date().toISOString(), id=await nextId();
      const row={id,ge_tracking_number:ge,carrier_tracking_number:parsed.trackingNumber||'PENDING',carrier,customer_name:parsed.toName||parsed.customerName||'Unknown',from_name:parsed.fromName||'',from_address:parsed.fromAddress||'',to_name:parsed.toName||'',to_address:parsed.toAddress||'',service_type:parsed.serviceType||'Garuda Express',weight:parsed.weight||'',dimensions:parsed.dimensions||'',pieces:parsed.pieces||'',description:parsed.description||'',ship_date:parsed.shipDate||'',created_at:now,updated_at:now};
      await saveShip(row); res.json({success:true,geNumber:ge,parsed,message:'Garuda tracking number assigned: '+ge});
    }catch(e){res.json({success:false,error:e.message});}
  });
});

app.post('/api/portal/upload-bulk', requirePortal, (req,res) => {
  upload.array('waybills',20)(req,res,async err=>{
    if(err) return res.json({success:false,error:err.message});
    if(!req.files?.length) return res.json({success:false,error:'No files'});
    const results=[];
    for(const f of req.files){
      try{
        const parsed=parseWaybill(f.buffer), carrier=parsed.carrier||(req.body.carrier||'DHL').toUpperCase();
        const ge=await nextGE(), now=new Date().toISOString(), id=await nextId();
        const row={id,ge_tracking_number:ge,carrier_tracking_number:parsed.trackingNumber||'PENDING',carrier,customer_name:parsed.toName||parsed.customerName||'Unknown',from_name:parsed.fromName||'',from_address:parsed.fromAddress||'',to_name:parsed.toName||'',to_address:parsed.toAddress||'',service_type:parsed.serviceType||'Garuda Express',weight:parsed.weight||'',dimensions:'',pieces:parsed.pieces||'',description:parsed.description||'',ship_date:parsed.shipDate||'',created_at:now,updated_at:now};
        await saveShip(row); results.push({success:true,filename:f.originalname,geNumber:ge,parsed});
      }catch(e){results.push({success:false,filename:f.originalname,error:e.message});}
    }
    res.json({success:true,results,total:results.length,succeeded:results.filter(r=>r.success).length});
  });
});

function parseWaybill(buf) {
  const p={carrier:'',trackingNumber:'',pieces:'1',fromName:'',fromAddress:'',toName:'',toAddress:'',serviceType:'',weight:'',dimensions:'',description:'',shipDate:'',customerName:''};
  try{
    const t=buf.toString('latin1').replace(/[ \t]+/g,' ');
    if(/FedEx|FEDEX|TRK#/i.test(t)) p.carrier='FEDEX'; else if(/\bDHL\b/i.test(t)) p.carrier='DHL'; else if(/\bUPS\b/i.test(t)) p.carrier='UPS';
    const um=t.match(/\b(1Z\s?[A-Z0-9]{3}\s?[A-Z0-9]{3}\s?[A-Z0-9]{2}\s?[A-Z0-9]{4}\s?[A-Z0-9]{4})\b/i);
    const tm=t.match(/TRK#\s+([\d][\d ]{10,16}[\d])/i), wm=t.match(/WAYBILL\s+([\d][\d\s]{6,14}[\d])/i);
    if(um){p.trackingNumber=um[1].replace(/\s/g,'').toUpperCase();if(!p.carrier)p.carrier='UPS';}
    else if(tm){p.trackingNumber=tm[1].replace(/\s/g,'');if(!p.carrier)p.carrier='FEDEX';}
    else if(wm){p.trackingNumber=wm[1].replace(/\s/g,'');if(!p.carrier)p.carrier='DHL';}
    const wt=t.match(/(?:ACTWGT|SHP\s*WT)[:\s]*([\d.]+\s*KG)/i)||t.match(/\b([\d.]+)\s*KG\b/i);
    if(wt) p.weight=wt[1].trim().toUpperCase().includes('KG')?wt[1].trim():wt[1].trim()+' KG';
    const dt=t.match(/(?:SHIP\s*DATE)[:\s]*(\d{1,2}\s*[A-Z]{3}\s*\d{2,4})/i); if(dt) p.shipDate=dt[1].trim();
    p.customerName=p.toName||p.fromName||'Unknown';
  }catch(e){}
  return p;
}

// ── Waybill HTML
app.get('/api/waybill/:ge/html', async (req,res) => {
  const s=await getSess(req.headers['x-admin-token']||req.query.token);
  if(!s||Date.now()>s.expiry) return res.status(401).send('<h2>Session expired</h2>');
  const row=await getShip(req.params.ge.toUpperCase());
  if(!row) return res.status(404).send('<h2>Not found</h2>');
  res.set('Content-Type','text/html'); res.send(waybillHTML(row));
});

function waybillHTML(row) {
  const date=row.ship_date||new Date(row.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  const svc=(row.service_type||'').replace(/\b(DHL|UPS|FEDEX|FedEx)\b/gi,'Garuda Express')||'Garuda Express International';
  const bc=row.ge_tracking_number.replace(/-/g,'');
  const bars=[];let x=8,isBar=true;const ww=[2,1,2,3,1,3,1,1,2,2,3,2,1,1,3,1,2,3,2,1,1,3,3,1,1,2,1,3,2,3];
  for(let i=0;i<bc.length;i++){const c=bc.charCodeAt(i),pat=[ww[c%10],ww[(c>>2)%10],ww[(c>>4)%8+2],ww[(c>>6)%10]];for(const w of pat){if(isBar)bars.push(`<rect x="${x}" y="4" width="${w*2}" height="48" fill="#000"/>`);x+=w*2+1;isBar=!isBar;}isBar=true;x+=1;}
  bars.push(`<rect x="${x}" y="4" width="3" height="48" fill="#000"/>`);x+=4;bars.push(`<rect x="${x}" y="4" width="1" height="48" fill="#000"/>`);x+=4;
  const bsvg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x+8} 68" style="width:100%;max-width:280px;height:auto"><rect width="100%" height="100%" fill="white"/>${bars.join('')}<text x="${(x+16)/2}" y="66" text-anchor="middle" font-family="Courier New,monospace" font-size="9" fill="#000">${bc}</text></svg>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Waybill ${row.ge_tracking_number}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#e8e8e8;padding:24px;display:flex;justify-content:center}.wb{width:148mm;background:#fff;border:2px solid #1a0820}.wb-hdr{background:#1a0820;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center}.ge-val{font-family:monospace;font-size:14px;font-weight:800;letter-spacing:2.5px;color:#C9A0F0}.svc-band{background:#5B2D8B;padding:6px 14px;display:flex;justify-content:space-between;align-items:center;color:#fff;font-size:11px;font-weight:700}.ag{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #ddd}.ab{padding:9px 12px}.ab:first-child{border-right:1px solid #ddd}.ab-lbl{font-size:6.5px;text-transform:uppercase;letter-spacing:1.5px;color:#5B2D8B;font-weight:700;margin-bottom:5px}.ab-name{font-size:10.5px;font-weight:700;color:#1a0820;margin-bottom:3px}.ab-addr{font-size:8.5px;color:#444;line-height:1.5;white-space:pre-line}.dg{display:grid;grid-template-columns:1fr 1fr 0.6fr 1fr;border-bottom:1px solid #ddd}.dc{padding:6px 10px;border-right:1px solid #f0f0f0}.dc span:first-child{display:block;font-size:6px;text-transform:uppercase;color:#999;margin-bottom:2px}.dc span:last-child{font-size:9.5px;font-weight:700;color:#1a0820}.bcs{padding:12px;border-bottom:1px solid #ddd;text-align:center;background:#fafafa}.ge-bc{font-family:monospace;font-size:15px;font-weight:800;letter-spacing:4px;color:#1a0820;margin-top:3px;display:block}.ct{padding:7px 12px;background:#f7f4ff;border-bottom:1px solid #ddd}.ct-lbl{font-size:6.5px;text-transform:uppercase;color:#888}.ct-val{font-family:monospace;font-size:10px;font-weight:700;color:#1a0820}.wf{background:#f9f9f9;padding:8px 12px;display:flex;justify-content:space-between;align-items:center}.wf-c{font-size:7.5px;color:#555;line-height:1.5}.no-print{position:fixed;top:16px;right:16px;display:flex;gap:10px}.no-print button{padding:10px 20px;border:none;border-radius:8px;font-weight:700;cursor:pointer}@media print{.no-print{display:none!important}}</style></head><body>
<div class="no-print"><button style="background:#5B2D8B;color:#fff" onclick="window.print()">Print</button><button style="background:#333;color:#fff" onclick="window.close()">Close</button></div>
<div class="wb"><div class="wb-hdr"><span style="color:#fff;font-weight:900;font-size:16px">GARUDA EXPRESS</span><div><div style="font-size:6px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,0.45)">Tracking ID</div><div class="ge-val">${row.ge_tracking_number}</div></div></div>
<div class="svc-band"><span>${svc}</span><span style="font-weight:400;opacity:0.8;font-size:9px">${date}</span></div>
<div class="ag"><div class="ab"><div class="ab-lbl">Sender</div><div class="ab-name">${row.from_name||row.customer_name||'—'}</div><div class="ab-addr">${(row.from_address||'—').replace(/,\s*/g,'\n')}</div></div><div class="ab"><div class="ab-lbl">Recipient</div><div class="ab-name">${row.to_name||'—'}</div><div class="ab-addr">${(row.to_address||'—').replace(/,\s*/g,'\n')}</div></div></div>
<div class="dg"><div class="dc"><span>Weight</span><span>${row.weight||'—'}</span></div><div class="dc"><span>Dimensions</span><span>${row.dimensions||'—'}</span></div><div class="dc"><span>Pieces</span><span>${row.pieces||'1'}</span></div><div class="dc"><span>Ship Date</span><span>${date}</span></div></div>
${row.description?`<div style="padding:5px 12px;border-bottom:1px solid #ddd;font-size:9px"><b style="color:#999;text-transform:uppercase">Contents:</b> ${row.description}</div>`:''}
<div class="bcs">${bsvg}<span class="ge-bc">${row.ge_tracking_number}</span></div>
<div class="ct"><div class="ct-lbl">Carrier Tracking Reference</div><div class="ct-val">${row.carrier_tracking_number}</div></div>
<div class="wf"><div class="wf-c"><b>Garuda Express International</b> · Anna Nagar, Chennai<br>+91 81222 57307 | info@garudaexpresscourier.com</div><div style="font-size:8px;font-weight:800;color:#5B2D8B">garudaexpresscourier.com</div></div></div></body></html>`;
}

// ── Dashboard
app.get('/api/dashboard/shipments', requireAuth, async (req,res) => {
  const {from,to,carrier,search}=req.query;
  let list=await allShips();
  if(from) list=list.filter(s=>s.created_at.slice(0,10)>=from);
  if(to) list=list.filter(s=>s.created_at.slice(0,10)<=to);
  if(carrier&&carrier!=='ALL') list=list.filter(s=>s.carrier===carrier.toUpperCase());
  if(search){const q=search.toLowerCase();list=list.filter(s=>[s.ge_tracking_number,s.carrier_tracking_number,s.customer_name,s.to_name].some(v=>(v||'').toLowerCase().includes(q)));}
  res.json({success:true,shipments:list.map((r,i)=>({sNo:i+1,id:r.id,date:r.created_at,geTrackingNumber:r.ge_tracking_number,carrierTrackingNumber:r.carrier_tracking_number,carrier:r.carrier,customerName:r.customer_name,fromName:r.from_name,fromAddress:r.from_address,toName:r.to_name,toAddress:r.to_address,serviceType:r.service_type,weight:r.weight,dimensions:r.dimensions,description:r.description,updatedAt:r.updated_at})),total:list.length,stats:await getStats()});
});

app.put('/api/dashboard/shipments/:id', requireAuth, async (req,res) => {
  const id=parseInt(req.params.id), all=await allShips(), row=all.find(s=>s.id===id);
  if(!row) return res.json({success:false,error:'Not found'});
  const {customerName,fromName,fromAddress,toName,toAddress,serviceType,weight,dimensions,carrierTrackingNumber,description}=req.body||{};
  Object.assign(row,{customer_name:customerName||row.customer_name,from_name:fromName||row.from_name,from_address:fromAddress||row.from_address,to_name:toName||row.to_name,to_address:toAddress||row.to_address,service_type:serviceType||row.service_type,weight:weight||row.weight,dimensions:dimensions||row.dimensions,carrier_tracking_number:carrierTrackingNumber||row.carrier_tracking_number,description:description||row.description,updated_at:new Date().toISOString()});
  await saveShip(row); await db.del(K.cache(row.ge_tracking_number));
  res.json({success:true});
});

app.get('/api/health', async (req,res) => {
  const all=await allShips();
  res.json({status:'ok',shipments:all.length,persistence:useKV()?'upstash-redis':'in-memory-fallback',version:'5.0.0-upstash'});
});

app.use('/api/*',(req,res)=>res.status(404).json({error:'Not found'}));
module.exports = (req,res) => app(req,res);
