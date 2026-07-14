// src/pages/NewShipment.jsx — Create new shipment with OCR scan
import React, { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FaArrowRotateRight, FaFileLines, FaPaperclip, FaCheck, FaTriangleExclamation,
  FaPaperPlane, FaInbox, FaClipboardList, FaTruck, FaScaleBalanced, FaPlus, FaSatelliteDish,
} from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { confirmAndDownloadWaybills } from '../utils/waybillDownload.js'

const CARRIERS = ['FedEx','UPS','DHL','Aramex','BlueDart','DTDC','Trackon','Delhivery','Ekart','IndiaPost','Xpressbees','Shadowfax','Professional Couriers','TNT','Purolator','Australia Post','Other']
const STATUSES = ['Processing','Picked Up','In Transit','Out for Delivery','Delivered','Exception','Returned']

const inp = { width:'100%', border:'1.5px solid #e5e7eb', borderRadius:10, padding:'9px 14px', fontSize:13, outline:'none', boxSizing:'border-box', transition:'border-color 0.2s', fontFamily:'inherit' }
const lbl = { display:'block', fontSize:9, color:'#9c88bb', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:5, fontWeight:700 }

function F({ label, name, value, onChange, type='text', options, required, placeholder }) {
  return (
    <div>
      <label style={lbl}>{label}{required&&<span style={{color:'#ef4444',marginLeft:3}}>*</span>}</label>
      {options ? (
        <select name={name} value={value||''} onChange={onChange} style={{ ...inp, backgroundColor:'white' }}>
          <option value="">— Select —</option>
          {options.map(o=><option key={o} value={o}>{o}</option>)}
        </select>
      ) : type === 'textarea' ? (
        <textarea name={name} value={value||''} onChange={onChange} rows={3} style={{ ...inp, resize:'none' }} placeholder={placeholder} />
      ) : (
        <input type={type} name={name} value={value||''} onChange={onChange} required={required} style={inp} placeholder={placeholder} />
      )}
    </div>
  )
}

function Card({ title, icon, children }) {
  return (
    <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
      <h2 style={{ fontSize:12, fontWeight:700, color:'#7B3FAD', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:20, display:'flex', alignItems:'center', gap:6 }}>
        <span style={{ fontSize:16 }}>{icon}</span> {title}
      </h2>
      {children}
    </div>
  )
}

export default function NewShipment() {
  const { authFetch } = useAuth()
  const navigate = useNavigate()
  const fileRef  = useRef()

  const [form,       setForm]       = useState({ status:'Processing', currency:'INR', pieces:1, weight_unit:'kg', auto_tracking_enabled:true })
  const [saving,     setSaving]     = useState(false)
  const [ocrLoading, setOcrLoading] = useState(false)
  const [ocrFile,    setOcrFile]    = useState(null)
  const [ocrConf,    setOcrConf]    = useState(null)
  const [error,      setError]      = useState(null)
  const [ocrMsg,     setOcrMsg]     = useState(null)

  const set = (e) => setForm(f => ({ ...f, [e.target.name]: e.target.value }))

  const handleOCR = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setOcrFile(file.name); setOcrLoading(true); setOcrMsg(null); setError(null)
    const fd = new FormData(); fd.append('waybill', file)
    try {
      const res  = await authFetch('/api/shipments/upload-ocr', { method:'POST', body:fd })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setOcrConf(data.confidence)
      // Merge OCR into form
      const ocr = data.fields || {}
      setForm(f => ({
        ...f,
        ...Object.fromEntries(Object.entries(ocr).filter(([,v]) => v !== null && v !== undefined)),
        original_waybill_file: data.filename,
        ocr_confidence: data.confidence,
        ocr_raw_text: data.rawText
      }))
      setOcrMsg(`Scan complete — ${data.confidence.toFixed(0)}% confidence. Review fields below.`)
    } catch (err) { setError('OCR failed: ' + err.message) }
    finally { setOcrLoading(false) }
  }

  const handleSubmit = async (e) => {
    e.preventDefault(); setSaving(true); setError(null)
    try {
      const res  = await authFetch('/api/shipments', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      try { await confirmAndDownloadWaybills(authFetch, [data.data.id]) }
      catch (err) { alert('Waybill generation failed: ' + err.message) }
      navigate(`/shipments/${data.data.id}`)
    } catch (err) { setError(err.message); setSaving(false) }
  }

  return (
    <AdminLayout>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
        <button onClick={() => navigate('/shipments')}
          style={{ width:38, height:38, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:12, border:'1.5px solid #e5e7eb', backgroundColor:'white', cursor:'pointer', color:'#374151' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div>
          <h1 style={{ fontSize:22, fontWeight:800, color:'#1a0820', margin:0 }}>New Shipment</h1>
          <p style={{ color:'#766D82', fontSize:13, marginTop:2 }}>Scan a waybill or enter details manually</p>
        </div>
      </div>

      {/* OCR Upload */}
      <div onClick={() => fileRef.current?.click()}
        style={{ backgroundColor:'white', border:`2px dashed ${ocrMsg?'#7B3FAD':'#d8b4fe'}`, borderRadius:20, padding:24, marginBottom:20, cursor:'pointer', display:'flex', alignItems:'center', gap:16, transition:'all 0.2s' }}
        onMouseEnter={e=>e.currentTarget.style.backgroundColor='#faf5ff'}
        onMouseLeave={e=>e.currentTarget.style.backgroundColor='white'}>
        <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,.tiff,.pdf,.webp" onChange={handleOCR} style={{ display:'none' }} />
        <div style={{ width:48, height:48, borderRadius:14, backgroundColor:ocrMsg?'rgba(123,63,173,0.15)':'rgba(123,63,173,0.08)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, flexShrink:0, color:'#7B3FAD' }}>
          {ocrLoading ? <FaArrowRotateRight size={20} style={{ animation:'spin 0.8s linear infinite' }} /> : <FaFileLines size={20} />}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, color:'#1a0820', fontSize:14 }}>
            {ocrLoading ? 'Scanning waybill…' : 'Scan Original Waybill via OCR'}
          </div>
          <div style={{ fontSize:12, color:'#888', marginTop:3, display:'flex', alignItems:'center', gap:5 }}>
            {ocrFile ? <><FaPaperclip size={10} /> {ocrFile}{ocrConf ? ` · ${ocrConf.toFixed(0)}% confidence` : ''}</> : 'Click to upload — FedEx, UPS, DHL, Aramex PDFs auto-detected'}
          </div>
          {ocrMsg && <div style={{ fontSize:12, color:'#059669', fontWeight:600, marginTop:4, display:'flex', alignItems:'center', gap:5 }}><FaCheck size={10} /> {ocrMsg}</div>}
        </div>
        <div style={{ padding:'7px 14px', border:'1.5px solid rgba(123,63,173,0.4)', borderRadius:10, color:'#7B3FAD', fontSize:12, fontWeight:700, flexShrink:0 }}>Upload & Scan</div>
      </div>

      {error && <div style={{ backgroundColor:'#fef2f2', border:'1px solid #fca5a5', color:'#dc2626', borderRadius:12, padding:'12px 16px', marginBottom:16, fontSize:13, display:'flex', alignItems:'center', gap:8 }}><FaTriangleExclamation size={13} /> {error}</div>}

      <form onSubmit={handleSubmit}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 320px', gap:20 }} className="form-grid">

          {/* LEFT column */}
          <div style={{ display:'flex', flexDirection:'column', gap:20 }}>

            <Card title="Sender / From" icon={<FaPaperPlane />}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
                <F label="Full Name"    name="from_name"    value={form.from_name}    onChange={set} required />
                <F label="Phone"        name="from_contact" value={form.from_contact} onChange={set} type="tel" />
                <div style={{ gridColumn:'1/-1' }}>
                  <F label="Street Address" name="from_address" value={form.from_address} onChange={set} />
                </div>
                <F label="City"    name="from_city"    value={form.from_city}    onChange={set} />
                <F label="State"   name="from_state"   value={form.from_state}   onChange={set} />
                <F label="Country" name="from_country" value={form.from_country} onChange={set} />
                <F label="Postal"  name="from_postal"  value={form.from_postal}  onChange={set} />
              </div>
            </Card>

            <Card title="Recipient / To" icon={<FaInbox />}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
                <F label="Full Name"    name="to_name"    value={form.to_name}    onChange={set} required />
                <F label="Phone"        name="to_contact" value={form.to_contact} onChange={set} type="tel" />
                <div style={{ gridColumn:'1/-1' }}>
                  <F label="Street Address" name="to_address" value={form.to_address} onChange={set} />
                </div>
                <F label="City"    name="to_city"    value={form.to_city}    onChange={set} />
                <F label="State"   name="to_state"   value={form.to_state}   onChange={set} />
                <F label="Country" name="to_country" value={form.to_country} onChange={set} />
                <F label="Postal"  name="to_postal"  value={form.to_postal}  onChange={set} />
              </div>
            </Card>

            <Card title="Contents & Instructions" icon={<FaClipboardList />}>
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <F label="Description / Contents"  name="contents"             value={form.contents}             onChange={set} type="textarea" placeholder="e.g. Indian Branded Spices, Cotton Kurta Set…" />
                <F label="Special Instructions"    name="special_instructions" value={form.special_instructions} onChange={set} type="textarea" placeholder="Fragile, Keep Dry, etc." />
              </div>
            </Card>
          </div>

          {/* RIGHT sidebar */}
          <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
            <Card title="Carrier Details" icon={<FaTruck />}>
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <F label="Carrier"             name="carrier"                 value={form.carrier}                 onChange={set} options={CARRIERS} />
                <F label="Carrier Tracking #"  name="carrier_tracking_number" value={form.carrier_tracking_number} onChange={set} placeholder="e.g. 880713889266" />
                <F label="Invoice Number"      name="invoice_number"          value={form.invoice_number}          onChange={set} />
              </div>
            </Card>

            <Card title="Auto Tracking" icon={<FaSatelliteDish />}>
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <div>
                  <label style={lbl}>Auto Tracking (TrackingMore / 17Track)</label>
                  <select name="auto_tracking_enabled" value={form.auto_tracking_enabled ? '1' : '0'}
                    onChange={e => setForm(f => ({ ...f, auto_tracking_enabled: e.target.value === '1' }))}
                    style={{ ...inp, backgroundColor:'white' }}>
                    <option value="1">Enabled</option>
                    <option value="0">Disabled</option>
                  </select>
                </div>

                <div style={{ fontSize:11, color:'#9ca3af', lineHeight:1.5 }}>
                  When enabled, this shipment is registered with a tracking provider once, right after saving — from
                  then on the provider tracks it and pushes status updates here automatically.
                </div>
              </div>
            </Card>

            <Card title="Shipment Details" icon={<FaScaleBalanced />}>
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <F label="Status"              name="status"         value={form.status}         onChange={set} options={STATUSES} />
                <F label="Ship Date"           name="ship_date"      value={form.ship_date}      onChange={set} type="date" />
                <F label="No. of Pieces"       name="pieces"         value={form.pieces}         onChange={set} type="number" />
                <F label="Actual Weight (kg)"  name="actual_weight"  value={form.actual_weight}  onChange={set} type="number" />
                <F label="Billing Weight (kg)" name="billing_weight" value={form.billing_weight} onChange={set} type="number" />
                <F label="Dimensions (L×W×H)"  name="dimensions"     value={form.dimensions}     onChange={set} placeholder="49×39×23 cm" />
                <F label="Declared Value"      name="declared_value" value={form.declared_value} onChange={set} type="number" />
                <F label="Currency"            name="currency"       value={form.currency}       onChange={set} />
              </div>
            </Card>

            <button type="submit" disabled={saving}
              style={{ padding:'14px 0', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', borderRadius:16, fontSize:15, fontWeight:800, cursor:saving?'not-allowed':'pointer', opacity:saving?0.7:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8, boxShadow:'0 8px 24px rgba(123,63,173,0.3)', width:'100%' }}>
              <span style={{ display:'inline-flex', animation:saving?'spin 0.8s linear infinite':undefined }}>
                {saving ? <FaArrowRotateRight size={15} /> : <FaPlus size={15} />}
              </span>
              {saving ? 'Creating Shipment…' : 'Create Shipment'}
            </button>
          </div>
        </div>
      </form>

      <style>{`
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        .form-grid { grid-template-columns: 1fr !important; }
        @media(min-width: 900px) { .form-grid { grid-template-columns: 1fr 320px !important; } }
      `}</style>
    </AdminLayout>
  )
}