// src/pages/AuditLog.jsx
import React, { useState, useEffect } from 'react'
import { FaDownload, FaXmark, FaCheck, FaArrowLeft, FaArrowRight } from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import { useAuth } from '../context/AuthContext.jsx'

const ACTION_STYLES = {
  LOGIN_SUCCESS:    { bg:'rgba(5,150,105,0.1)',   color:'#059669' },
  LOGIN_FAILURE:    { bg:'rgba(220,38,38,0.1)',   color:'#dc2626' },
  LOGOUT:           { bg:'rgba(107,114,128,0.1)', color:'#4b5563' },
  SHIPMENT_CREATE:  { bg:'rgba(5,150,105,0.1)',   color:'#059669' },
  SHIPMENT_UPDATE:  { bg:'rgba(217,119,6,0.1)',   color:'#d97706' },
  SHIPMENT_REPROCESS: { bg:'rgba(37,99,235,0.1)', color:'#2563eb' },
  SHIPMENT_DELETE:  { bg:'rgba(220,38,38,0.1)',   color:'#dc2626' },
  GENERATE_WAYBILL: { bg:'rgba(123,63,173,0.1)',  color:'#7B3FAD' },
  CREATE_USER:      { bg:'rgba(6,182,212,0.1)',   color:'#0891b2' },
  UPDATE_USER:      { bg:'rgba(217,119,6,0.1)',   color:'#d97706' },
  DEACTIVATE_USER:  { bg:'rgba(220,38,38,0.1)',   color:'#dc2626' },
  PASSWORD_RESET:   { bg:'rgba(217,119,6,0.1)',   color:'#d97706' },
  FORCE_PASSWORD_RESET: { bg:'rgba(124,58,237,0.1)', color:'#7c3aed' },
  UNLOCK_ACCOUNT:   { bg:'rgba(5,150,105,0.1)',   color:'#059669' },
  BULK_UPLOAD:      { bg:'rgba(37,99,235,0.1)',   color:'#2563eb' },
  API_FAILURE:      { bg:'rgba(220,38,38,0.1)',   color:'#dc2626' },
  TRACKING_SYNC:    { bg:'rgba(217,119,6,0.1)',   color:'#d97706' },
  CARRIER_CREATE:   { bg:'rgba(6,182,212,0.1)',   color:'#0891b2' },
  CARRIER_UPDATE:   { bg:'rgba(217,119,6,0.1)',   color:'#d97706' },
  SETTINGS_UPDATE:  { bg:'rgba(123,63,173,0.1)',  color:'#7B3FAD' },
  AUDIT_EXPORT:     { bg:'rgba(107,114,128,0.1)', color:'#4b5563' },
}

export default function AuditLog() {
  const { authFetch, token } = useAuth()
  const [logs,    setLogs]    = useState([])
  const [total,   setTotal]   = useState(0)
  const [page,    setPage]    = useState(1)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ action:'', username:'', status:'' })
  const LIMIT = 50

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams({ page, limit: LIMIT, ...Object.fromEntries(Object.entries(filters).filter(([,v])=>v)) })
    authFetch(`/api/admin/audit?${params}`)
      .then(r=>r.json())
      .then(d=>{ if(d.success){ setLogs(d.data); setTotal(d.total) } })
      .finally(()=>setLoading(false))
  }
  useEffect(load, [page])

  const applyFilters = (e) => { e.preventDefault(); setPage(1); load() }

  const fmt = ts => { try { return new Date(ts + 'Z').toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) } catch { return ts } }
  const totalPages = Math.ceil(total / LIMIT)

  const exportLog = (format) => {
    // Direct download with token as query param (the /uploads-style auth gate
    // doesn't apply here, but admin endpoints need the bearer token; since
    // <a download> can't set headers, we open via fetch+blob instead).
    authFetch(`/api/admin/audit/export?format=${format}`).then(async (res) => {
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit_log.${format === 'excel' ? 'xlsx' : format}`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    })
  }

  const inp = { border:'1.5px solid #e5e7eb', borderRadius:10, padding:'8px 12px', fontSize:12, outline:'none', fontFamily:'inherit' }

  return (
    <AdminLayout>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:24, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>Audit Log</h1>
          <p style={{ color:'#766D82', fontSize:14, marginTop:4 }}>{total} total events · retained 365 days</p>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {['csv','excel','pdf'].map(fmt => (
            <button key={fmt} onClick={()=>exportLog(fmt)}
              style={{ padding:'9px 16px', borderRadius:10, border:'1.5px solid #7B3FAD', backgroundColor:'white', color:'#7B3FAD', fontSize:12, fontWeight:700, cursor:'pointer', textTransform:'uppercase', display:'inline-flex', alignItems:'center', gap:6 }}>
              <FaDownload size={11} /> {fmt}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={applyFilters} style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:16 }}>
        <input placeholder="Filter by username…" value={filters.username} onChange={e=>setFilters(f=>({...f,username:e.target.value}))} style={inp} />
        <input placeholder="Action (e.g. LOGIN_SUCCESS)" value={filters.action} onChange={e=>setFilters(f=>({...f,action:e.target.value}))} style={inp} />
        <select value={filters.status} onChange={e=>setFilters(f=>({...f,status:e.target.value}))} style={{...inp, backgroundColor:'white'}}>
          <option value="">Any status</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
        <button type="submit" style={{ padding:'8px 18px', borderRadius:10, border:'none', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', fontSize:12, fontWeight:700, cursor:'pointer' }}>Apply</button>
      </form>

      {loading ? (
        <div style={{ textAlign:'center', padding:48, color:'#9ca3af' }}>Loading audit log…</div>
      ) : (
        <div style={{ backgroundColor:'white', borderRadius:20, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)', overflow:'hidden' }}>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ borderBottom:'1px solid #f0e8f9', backgroundColor:'#faf5ff' }}>
                  {['Time','User','Action','Entity','IP / Device','Status','Details'].map(h => (
                    <th key={h} style={{ padding:'12px 16px', textAlign:'left', fontWeight:700, color:'#7B3FAD', fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map((log,i) => {
                  const style = ACTION_STYLES[log.action] || { bg:'rgba(107,114,128,0.1)', color:'#4b5563' }
                  return (
                    <tr key={log.id} style={{ borderBottom:'1px solid #faf5ff', backgroundColor:i%2===0?'white':'#fdf8ff' }}>
                      <td style={{ padding:'12px 16px', color:'#9ca3af', fontSize:11, fontFamily:'monospace', whiteSpace:'nowrap' }}>{fmt(log.created_at)}</td>
                      <td style={{ padding:'12px 16px' }}>
                        <div style={{ fontWeight:600, color:'#1a0820', fontSize:12 }}>@{log.username || 'system'}</div>
                        {log.role && <div style={{ color:'#9ca3af', fontSize:10, textTransform:'capitalize' }}>{log.role}</div>}
                      </td>
                      <td style={{ padding:'12px 16px' }}>
                        <span style={{ backgroundColor:style.bg, color:style.color, padding:'3px 10px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>
                          {log.action}
                        </span>
                      </td>
                      <td style={{ padding:'12px 16px', color:'#766D82', fontSize:12 }}>{log.entity} {log.entity_id ? `#${log.entity_id}` : ''}</td>
                      <td style={{ padding:'12px 16px', color:'#9ca3af', fontSize:11, maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={log.device}>{log.ip_address || '—'}</td>
                      <td style={{ padding:'12px 16px' }}>
                        <span style={{ color: log.status==='failure' ? '#dc2626' : '#059669', fontWeight:700, fontSize:11, textTransform:'uppercase', display:'inline-flex', alignItems:'center', gap:4 }}>
                          {log.status==='failure' ? <><FaXmark size={10} /> Failed</> : <><FaCheck size={10} /> OK</>}
                        </span>
                      </td>
                      <td style={{ padding:'12px 16px', color:'#9ca3af', fontSize:12, maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={log.details}>{log.details || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div style={{ padding:'12px 16px', borderTop:'1px solid #f0e8f9', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span style={{ fontSize:12, color:'#9ca3af' }}>Page {page} of {totalPages}</span>
              <div style={{ display:'flex', gap:6 }}>
                <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}
                  style={{ padding:'6px 14px', fontSize:12, borderRadius:8, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', cursor:page===1?'not-allowed':'pointer', opacity:page===1?0.4:1, display:'inline-flex', alignItems:'center', gap:6 }}><FaArrowLeft size={10} /> Prev</button>
                <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages}
                  style={{ padding:'6px 14px', fontSize:12, borderRadius:8, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', cursor:page===totalPages?'not-allowed':'pointer', opacity:page===totalPages?0.4:1, display:'inline-flex', alignItems:'center', gap:6 }}>Next <FaArrowRight size={10} /></button>
              </div>
            </div>
          )}
        </div>
      )}
    </AdminLayout>
  )
}
