// src/pages/AdminDashboard.jsx
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  FaBox, FaCloudArrowUp, FaPlus, FaMagnifyingGlass, FaCalendarDay, FaCircleCheck,
  FaTruck, FaTriangleExclamation, FaInbox, FaFileLines, FaArrowRight, FaUsers, FaClipboardList,
} from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import LoadingTruck from '../components/LoadingTruck.jsx'
import { useAuth } from '../context/AuthContext.jsx'

function StatCard({ icon, label, value, sub, color }) {
  const colors = {
    purple:  { bg:'rgba(123,63,173,0.08)', icon:'#7B3FAD', val:'#1a0820' },
    emerald: { bg:'rgba(5,150,105,0.08)',  icon:'#059669', val:'#1a0820' },
    amber:   { bg:'rgba(217,119,6,0.08)',  icon:'#d97706', val:'#1a0820' },
    red:     { bg:'rgba(220,38,38,0.08)',  icon:'#dc2626', val:'#1a0820' },
    blue:    { bg:'rgba(37,99,235,0.08)',  icon:'#2563eb', val:'#1a0820' },
  }
  const c = colors[color] || colors.purple
  return (
    <div style={{ backgroundColor:'white', borderRadius:20, padding:'20px 22px', border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:14 }}>
        <div style={{ width:40, height:40, borderRadius:12, backgroundColor:c.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, color:c.icon }}>
          {icon}
        </div>
        {sub && <span style={{ fontSize:9, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.1em', fontWeight:700 }}>{sub}</span>}
      </div>
      <div style={{ fontSize:30, fontWeight:800, color:c.val, lineHeight:1 }}>{value ?? '—'}</div>
      <div style={{ color:'#766D82', fontSize:13, marginTop:6 }}>{label}</div>
    </div>
  )
}

function MiniBar({ data }) {
  if (!data?.length) return <div style={{ color:'#ccc', fontSize:13, textAlign:'center', padding:20 }}>No data yet</div>
  const max = Math.max(...data.map(d=>d.count), 1)
  return (
    <div style={{ display:'flex', alignItems:'flex-end', gap:4, height:80, paddingTop:8 }}>
      {data.map((d,i) => (
        <div key={i} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
          <div style={{ width:'100%', borderRadius:'4px 4px 0 0', backgroundColor:'rgba(123,63,173,0.25)', height:`${(d.count/max)*64}px`, minHeight:3, transition:'height 0.6s ease', cursor:'default' }}
            title={`${d.date}: ${d.count} shipment${d.count!==1?'s':''}`} />
          <span style={{ fontSize:8, color:'#9ca3af', transform:'rotate(-40deg)', transformOrigin:'center top', whiteSpace:'nowrap', marginTop:2 }}>{d.date?.slice(5)}</span>
        </div>
      ))}
    </div>
  )
}

function EmployeeDashboard() {
  const { authFetch, user } = useAuth()
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      authFetch('/api/shipments?limit=1').then(r=>r.json()),
      authFetch('/api/bulk-upload').then(r=>r.json()),
    ]).then(([shipRes, bulkRes]) => {
      setSummary({
        myShipments: shipRes.total || 0,
        myUploads: bulkRes.data?.length || 0,
        recentUploads: (bulkRes.data || []).slice(0, 5),
      })
    }).finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingTruck text="Loading your dashboard…" />

  return (
    <>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>Welcome, {user?.name}</h1>
        <p style={{ color:'#766D82', fontSize:14, marginTop:4 }}>Your shipments and uploads at a glance</p>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:16, marginBottom:24 }}>
        <StatCard icon={<FaBox />} label="My Shipments" value={summary?.myShipments} color="purple" />
        <StatCard icon={<FaCloudArrowUp />} label="My Bulk Uploads" value={summary?.myUploads} color="blue" />
      </div>
      <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)', marginBottom:24 }}>
        <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>Recent Bulk Upload Jobs</h2>
        {!summary?.recentUploads?.length ? (
          <div style={{ color:'#9ca3af', fontSize:13 }}>No uploads yet.</div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {summary.recentUploads.map(j => (
              <div key={j.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:'1px solid #faf5ff' }}>
                <div>
                  <div style={{ fontWeight:600, fontSize:13, color:'#1a0820' }}>{j.file_name}</div>
                  <div style={{ fontSize:11, color:'#9ca3af' }}>{j.success_count} imported · {j.failed_count} failed</div>
                </div>
                <span style={{ fontSize:10, fontWeight:700, padding:'3px 10px', borderRadius:50, backgroundColor:'rgba(123,63,173,0.1)', color:'#7B3FAD' }}>{j.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
        <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>Quick Actions</h2>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))', gap:12 }}>
          {[
            { to:'/shipments/new',  icon:FaPlus, label:'New Shipment', bg:'rgba(123,63,173,0.08)', border:'rgba(123,63,173,0.2)', color:'#7B3FAD' },
            { to:'/shipments/bulk', icon:FaCloudArrowUp, label:'Bulk Upload',  bg:'rgba(59,130,246,0.08)', border:'rgba(59,130,246,0.2)', color:'#2563eb' },
            { to:'/shipments',      icon:FaMagnifyingGlass, label:'My Shipments', bg:'rgba(5,150,105,0.08)',  border:'rgba(5,150,105,0.2)',  color:'#059669' },
          ].map(a => (
            <Link key={a.to} to={a.to}
              style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:'16px 8px', borderRadius:16, border:`1.5px solid ${a.border}`, backgroundColor:a.bg, textDecoration:'none' }}>
              <span style={{ fontSize:22, color:a.color, display:'flex' }}><a.icon /></span>
              <span style={{ fontSize:12, fontWeight:700, color:a.color, textAlign:'center' }}>{a.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}

export default function AdminDashboard() {
  const { authFetch, isAdmin } = useAuth()
  const [stats, setStats]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [apiUsage, setApiUsage] = useState(null)

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    authFetch('/api/admin/stats').then(r=>r.json()).then(d=>{ if(d.success) setStats(d.stats) }).finally(()=>setLoading(false))
    authFetch('/api/admin/api-usage').then(r=>r.json()).then(d=>{ if(d.success) setApiUsage(d) }).catch(()=>{})
  }, [isAdmin])

  if (!isAdmin) return <AdminLayout><EmployeeDashboard /></AdminLayout>

  if (loading) return <AdminLayout><LoadingTruck text="Loading dashboard…" /></AdminLayout>
  if (!stats)  return <AdminLayout><div style={{ color:'#dc2626', padding:20 }}>Failed to load stats.</div></AdminLayout>

  return (
    <AdminLayout>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>Dashboard</h1>
        <p style={{ color:'#766D82', fontSize:14, marginTop:4 }}>Garuda Express operations overview</p>
      </div>

      {/* Stat cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:16, marginBottom:24 }}>
        <StatCard icon={<FaBox />} label="Total Shipments"    value={stats.total}             color="purple" />
        <StatCard icon={<FaCalendarDay />} label="Today"             value={stats.today}             color="blue"   sub="today" />
        <StatCard icon={<FaCircleCheck />} label="Delivered"          value={stats.delivered}         color="emerald" />
        <StatCard icon={<FaTruck />} label="In Transit"         value={stats.inTransit}         color="amber" />
        <StatCard icon={<FaTriangleExclamation />} label="Exceptions"        value={stats.exception}         color="red" />
        <StatCard icon={<FaInbox />} label="Manual Queue"       value={stats.manualQueue}       color="red" sub="needs attention" />
        <StatCard icon={<FaFileLines />} label="Waybills Generated" value={stats.waybillsGenerated} color="purple" />
        <StatCard icon={<FaCloudArrowUp />} label="Today's Uploads"   value={stats.todaysUploads}     color="blue" />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, marginBottom:24 }} className="dash-grid">

        {/* 7-day chart */}
        <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
            <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', margin:0 }}>Last 7 Days</h2>
            <Link to="/shipments" style={{ fontSize:12, color:'#7B3FAD', fontWeight:700, textDecoration:'none', display:'inline-flex', alignItems:'center', gap:5 }}>View All <FaArrowRight size={10} /></Link>
          </div>
          <MiniBar data={stats.last7days} />
        </div>

        {/* Carrier breakdown */}
        <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
          <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>Shipments by Carrier</h2>
          {stats.byCarrier.length === 0 ? (
            <div style={{ color:'#9ca3af', fontSize:13 }}>No carrier data yet.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {stats.byCarrier.slice(0,6).map(c => {
                const pct = stats.total ? Math.round((c.count/stats.total)*100) : 0
                return (
                  <div key={c.carrier}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                      <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>{c.carrier}</span>
                      <span style={{ fontSize:12, color:'#9ca3af' }}>{c.count} ({pct}%)</span>
                    </div>
                    <div style={{ height:6, backgroundColor:'#f0e8f9', borderRadius:50, overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${pct}%`, backgroundColor:'#7B3FAD', borderRadius:50, transition:'width 0.8s ease' }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, marginBottom:24 }} className="dash-grid">
        {/* API Health */}
        <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
          <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>API Health (24h)</h2>
          {!stats.apiHealth?.length ? (
            <div style={{ color:'#9ca3af', fontSize:13 }}>No API calls logged yet.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {stats.apiHealth.map(a => (
                <div key={a.provider} style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:13, fontWeight:600, color:'#374151', textTransform:'capitalize' }}>{a.provider.replace('_',' ')}</span>
                  <span style={{ fontSize:12, fontWeight:700, color: a.success_rate >= 90 ? '#059669' : a.success_rate >= 50 ? '#d97706' : '#dc2626' }}>
                    {a.success_rate}% · {a.avg_response_ms}ms
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Employee activity */}
        <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
          <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>Team Activity (7d)</h2>
          {!stats.employeeActivity?.length ? (
            <div style={{ color:'#9ca3af', fontSize:13 }}>No activity yet.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {stats.employeeActivity.map(e => (
                <div key={e.username} style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:13, fontWeight:600, color:'#374151' }}>@{e.username}</span>
                  <span style={{ fontSize:12, color:'#9ca3af' }}>{e.actions} actions</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tracking API Usage — TrackingMore & 17Track quota utilization */}
      <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)', marginBottom:24 }}>
        <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>Tracking API Usage</h2>
        {!apiUsage ? (
          <div style={{ color:'#9ca3af', fontSize:13 }}>Loading…</div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }} className="dash-grid">
            {[
              { name: 'TrackingMore', data: apiUsage.trackingmore, fields: [
                  ['Quota Remaining', apiUsage.trackingmore?.quotaRemaining],
                  ['Plan Limit', apiUsage.trackingmore?.planLimit],
                  ['Plan Remaining', apiUsage.trackingmore?.planRemaining],
                  ['Consumed Total', apiUsage.trackingmore?.consumedTotal],
                ] },
              { name: '17Track', data: apiUsage.seventeentrack, fields: [
                  ['Quota Total', apiUsage.seventeentrack?.quotaTotal],
                  ['Quota Used', apiUsage.seventeentrack?.quotaUsed],
                  ['Quota Remaining', apiUsage.seventeentrack?.quotaRemaining],
                  ['Used Today', apiUsage.seventeentrack?.todayUsed],
                ] },
            ].map(p => (
              <div key={p.name} style={{ padding:16, borderRadius:14, backgroundColor:'#faf5ff', border:'1px solid #f0e8f9' }}>
                <div style={{ fontSize:13, fontWeight:800, color:'#1a0820', marginBottom:10 }}>{p.name}</div>
                {!p.data?.configured ? (
                  <div style={{ fontSize:12, color:'#9ca3af' }}>Not configured — add the API key in the backend .env file.</div>
                ) : p.data.error ? (
                  <div style={{ fontSize:12, color:'#dc2626' }}>{p.data.error}</div>
                ) : (
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {p.fields.map(([label, value]) => (
                      <div key={label}>
                        <div style={{ fontSize:18, fontWeight:800, color:'#1a0820' }}>{value ?? '—'}</div>
                        <div style={{ fontSize:10, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:700 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {apiUsage?.callStats?.length > 0 && (
          <div style={{ marginTop:18, paddingTop:16, borderTop:'1px solid #f0e8f9' }}>
            <div style={{ fontSize:11, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.08em', fontWeight:700, marginBottom:10 }}>Our Call Volume (24h)</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:16 }}>
              {apiUsage.callStats.map(a => (
                <div key={a.provider} style={{ fontSize:12 }}>
                  <span style={{ fontWeight:700, color:'#374151', textTransform:'capitalize' }}>{a.provider.replace('_',' ')}</span>
                  <span style={{ color: a.success_rate >= 90 ? '#059669' : a.success_rate >= 50 ? '#d97706' : '#dc2626', fontWeight:700, marginLeft:6 }}>
                    {a.total} calls · {a.success_rate}% success
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
        <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>Quick Actions</h2>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))', gap:12 }}>
          {[
            { to:'/shipments/new',  icon:FaPlus, label:'New Shipment',    bg:'rgba(123,63,173,0.08)', border:'rgba(123,63,173,0.2)', color:'#7B3FAD' },
            { to:'/shipments/bulk', icon:FaCloudArrowUp, label:'Bulk Upload',     bg:'rgba(59,130,246,0.08)', border:'rgba(59,130,246,0.2)', color:'#2563eb' },
            { to:'/shipments',      icon:FaMagnifyingGlass, label:'All Shipments',   bg:'rgba(5,150,105,0.08)',  border:'rgba(5,150,105,0.2)',  color:'#059669' },
            { to:'/admin/users',    icon:FaUsers, label:'Manage Users',    bg:'rgba(217,119,6,0.08)',  border:'rgba(217,119,6,0.2)',  color:'#d97706' },
            { to:'/admin/carriers', icon:FaTruck, label:'Carriers',        bg:'rgba(37,99,235,0.08)',  border:'rgba(37,99,235,0.2)',  color:'#2563eb' },
            { to:'/admin/audit',    icon:FaClipboardList, label:'Audit Log',       bg:'rgba(107,70,193,0.08)', border:'rgba(107,70,193,0.2)', color:'#6b46c1' },
          ].map(a => (
            <Link key={a.to} to={a.to}
              style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:'16px 8px', borderRadius:16, border:`1.5px solid ${a.border}`, backgroundColor:a.bg, textDecoration:'none', transition:'all 0.2s' }}
              onMouseEnter={e=>{ e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow='0 8px 20px rgba(0,0,0,0.08)' }}
              onMouseLeave={e=>{ e.currentTarget.style.transform='translateY(0)'; e.currentTarget.style.boxShadow='none' }}>
              <span style={{ fontSize:22, color:a.color, display:'flex' }}><a.icon /></span>
              <span style={{ fontSize:12, fontWeight:700, color:a.color, textAlign:'center' }}>{a.label}</span>
            </Link>
          ))}
        </div>
      </div>

      <style>{`.dash-grid{grid-template-columns:1fr!important} @media(min-width:768px){.dash-grid{grid-template-columns:1fr 1fr!important}}`}</style>
    </AdminLayout>
  )
}