// src/pages/ShipmentsPage.jsx
import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { FaXmark, FaBox, FaArrowRight, FaCheck, FaArrowLeft, FaDownload } from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import ConfirmModal from '../components/ConfirmModal.jsx'
import ChoiceModal from '../components/ChoiceModal.jsx'
import Toast from '../components/Toast.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import LoadingTruck from '../components/LoadingTruck.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useConfirm } from '../hooks/useConfirm.js'
import { useToast } from '../hooks/useToast.js'
import { downloadWaybill, downloadWaybillsZip } from '../utils/waybillDownload.js'
import { exportVisibleShipments, exportFullShipments } from '../utils/shipmentExport.js'

const STATUSES = ['Processing','Picked Up','In Transit','Out for Delivery','Delivered','Exception','Returned']
const CARRIERS  = ['FedEx','UPS','DHL','Aramex','BlueDart','DTDC','Trackon','Delhivery','Ekart','IndiaPost','Xpressbees','Shadowfax','Professional Couriers','TNT','Other']

export default function ShipmentsPage() {
  const { authFetch, isAdmin } = useAuth()
  const [shipments, setShipments] = useState([])
  const [total,     setTotal]     = useState(0)
  const [loading,   setLoading]   = useState(true)
  const [page,      setPage]      = useState(1)
  const LIMIT = 25

  const [q,        setQ]        = useState('')
  const [status,   setStatus]   = useState('')
  const [carrier,  setCarrier]  = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo,   setDateTo]   = useState('')
  const [deleting, setDeleting] = useState(false)
  const [syncing,  setSyncing]  = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [downloading, setDownloading] = useState(false)
  const { confirmState, confirm, handleConfirm, handleCancel } = useConfirm()
  const { toast, showToast } = useToast()

  // NOTE: the old admin-only Manual/Auto Tracking toggle that used to live
  // here is gone — shipments are registered with a tracking provider once
  // at creation (see services/trackingService.js), and updates normally
  // arrive via webhook. "Sync Pending Now" below is the manual fallback for
  // when the webhook can't reach this server yet (e.g. local development,
  // or before its URL is pasted into TrackingMore/17Track's dashboard —
  // see Settings) — it pulls current results immediately instead of
  // waiting for the automatic catch-up worker's next run.

  const fetchShipments = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page, limit:LIMIT })
    if (q)       params.set('q', q)
    if (status)  params.set('status', status)
    if (carrier) params.set('carrier', carrier)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo)   params.set('date_to', dateTo)
    const res  = await authFetch(`/api/shipments?${params}`)
    const data = await res.json()
    if (data.success) { setShipments(data.data); setTotal(data.total) }
    setSelected(new Set())
    setLoading(false)
  }, [page, q, status, carrier, dateFrom, dateTo])

  useEffect(() => { fetchShipments() }, [fetchShipments])

  const handleDelete = async (id, geNum) => {
    const ok = await confirm({
      title: 'Delete this shipment?',
      message: `Delete shipment ${geNum}? This cannot be undone.`,
      danger: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    setDeleting(true)
    await authFetch(`/api/shipments/${id}`, { method:'DELETE' })
    fetchShipments()
    setDeleting(false)
  }

  const toggleSelect = (id) => setSelected(s => {
    const next = new Set(s)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleSelectAll = () => setSelected(s => (
    s.size === shipments.length ? new Set() : new Set(shipments.map(s => s.id))
  ))

  const handleDownloadOne = async (id, geNum) => {
    setDownloading(true)
    try { await downloadWaybill(authFetch, id, `GarudaWaybill_${geNum}.pdf`) }
    catch (err) { showToast('Download failed: ' + err.message, 'error') }
    finally { setDownloading(false) }
  }

  const handleDownloadSelected = async () => {
    setDownloading(true)
    try { await downloadWaybillsZip(authFetch, [...selected]) }
    catch (err) { showToast('Download failed: ' + err.message, 'error') }
    finally { setDownloading(false) }
  }

  const handleSyncPending = async () => {
    setSyncing(true)
    try {
      const res  = await authFetch('/api/shipments/tracking/sync-pending', { method:'POST' })
      const data = await res.json()
      if (data.success) {
        showToast(`Checked ${data.checked} registered shipment(s) — ${data.updated} updated${data.failed ? `, ${data.failed} still no data yet` : ''}.`)
        fetchShipments()
      }
    } finally { setSyncing(false) }
  }

  const [exportChoiceOpen, setExportChoiceOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const handleExport = () => setExportChoiceOpen(true)

  const handleExportVisible = () => {
    setExportChoiceOpen(false)
    exportVisibleShipments(shipments)
  }

  const handleExportFull = async () => {
    setExportChoiceOpen(false)
    setExporting(true)
    try {
      await exportFullShipments(authFetch, { q, status, carrier, dateFrom, dateTo })
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error')
    } finally {
      setExporting(false)
    }
  }

  const clearFilters = () => { setQ(''); setStatus(''); setCarrier(''); setDateFrom(''); setDateTo(''); setPage(1) }
  const totalPages   = Math.ceil(total / LIMIT)
  const hasFilters   = q || status || carrier || dateFrom || dateTo

  return (
    <AdminLayout>
      <Toast toast={toast} />
      <ConfirmModal
        open={!!confirmState}
        title={confirmState?.title}
        message={confirmState?.message}
        danger={confirmState?.danger}
        confirmLabel={confirmState?.confirmLabel}
        confirmPhrase={confirmState?.confirmPhrase}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
      <ChoiceModal
        open={exportChoiceOpen}
        title="Export shipments"
        message="Choose what to include in the export."
        onCancel={() => setExportChoiceOpen(false)}
        options={[
          {
            label: 'Visible Content',
            description: `Just this page — the ${shipments.length} shipment(s) and columns currently shown in the table.`,
            onClick: handleExportVisible,
          },
          {
            label: 'Full Content',
            description: 'Every shipment matching the current filters (all pages), with every field.',
            onClick: handleExportFull,
            primary: true,
          },
        ]}
      />
      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16, marginBottom:24, flexWrap:'wrap' }}>
        <div>
          <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>Shipments</h1>
          <p style={{ color:'#766D82', fontSize:14, marginTop:4 }}>{total} total shipments</p>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {selected.size > 1 && (
            <button onClick={handleDownloadSelected} disabled={downloading}
              style={{ display:'flex', alignItems:'center', gap:6, border:'none', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', padding:'8px 16px', borderRadius:12, fontSize:13, fontWeight:700, cursor:downloading?'not-allowed':'pointer', opacity:downloading?0.6:1 }}>
              <FaDownload size={13} /> {downloading ? 'Preparing…' : `Download Selected (${selected.size})`}
            </button>
          )}
          {isAdmin && (
            <button onClick={handleSyncPending} disabled={syncing}
              title="Pull the latest status for any registered shipment that hasn't gotten an update yet — useful if TrackingMore/17Track's webhook can't reach this server yet (e.g. local development)"
              style={{ display:'flex', alignItems:'center', gap:6, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', padding:'8px 16px', borderRadius:12, fontSize:13, fontWeight:600, cursor:syncing?'not-allowed':'pointer', opacity:syncing?0.6:1 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={syncing?{ animation:'spin 0.8s linear infinite' }:undefined}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              {syncing ? 'Syncing…' : 'Sync Pending Now'}
            </button>
          )}
          {isAdmin && (
            <button onClick={handleExport} disabled={exporting}
              style={{ display:'flex', alignItems:'center', gap:6, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', padding:'8px 16px', borderRadius:12, fontSize:13, fontWeight:600, cursor: exporting ? 'not-allowed' : 'pointer', opacity: exporting ? 0.6 : 1 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {exporting ? 'Exporting…' : 'Export XLSX'}
            </button>
          )}
          <Link to="/shipments/bulk"
            style={{ display:'flex', alignItems:'center', gap:6, border:'1.5px solid #7B3FAD', color:'#7B3FAD', backgroundColor:'white', padding:'8px 16px', borderRadius:12, fontSize:13, fontWeight:700, textDecoration:'none' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
            Bulk Upload
          </Link>
          <Link to="/shipments/new"
            style={{ display:'flex', alignItems:'center', gap:6, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', padding:'8px 18px', borderRadius:12, fontSize:13, fontWeight:700, textDecoration:'none', boxShadow:'0 4px 12px rgba(123,63,173,0.25)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Shipment
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div style={{ backgroundColor:'white', borderRadius:16, padding:16, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)', marginBottom:16 }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 1fr 1fr', gap:12 }}>
          <div style={{ position:'relative' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input value={q} onChange={e=>{setQ(e.target.value);setPage(1)}}
              placeholder="Search by name, GE#, contact…"
              style={{ width:'100%', paddingLeft:36, paddingRight:12, paddingTop:9, paddingBottom:9, border:'1.5px solid #e5e7eb', borderRadius:10, fontSize:13, outline:'none', boxSizing:'border-box' }} />
          </div>
          <select value={status} onChange={e=>{setStatus(e.target.value);setPage(1)}}
            style={{ border:'1.5px solid #e5e7eb', borderRadius:10, padding:'9px 12px', fontSize:13, outline:'none', backgroundColor:'white' }}>
            <option value="">All Status</option>
            {STATUSES.map(s=><option key={s}>{s}</option>)}
          </select>
          {isAdmin && (
            <select value={carrier} onChange={e=>{setCarrier(e.target.value);setPage(1)}}
              style={{ border:'1.5px solid #e5e7eb', borderRadius:10, padding:'9px 12px', fontSize:13, outline:'none', backgroundColor:'white' }}>
              <option value="">All Carriers</option>
              {CARRIERS.map(c=><option key={c}>{c}</option>)}
            </select>
          )}
          <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setPage(1)}}
            style={{ border:'1.5px solid #e5e7eb', borderRadius:10, padding:'9px 12px', fontSize:13, outline:'none' }} />
          <input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setPage(1)}}
            style={{ border:'1.5px solid #e5e7eb', borderRadius:10, padding:'9px 12px', fontSize:13, outline:'none' }} />
        </div>
        {hasFilters && (
          <button onClick={clearFilters} style={{ marginTop:10, background:'none', border:'none', color:'#dc2626', fontSize:12, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
            <FaXmark size={11} /> Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ backgroundColor:'white', borderRadius:16, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)', overflow:'hidden' }}>
        {loading ? (
          <LoadingTruck text="Loading shipments…" />
        ) : shipments.length === 0 ? (
          <div style={{ textAlign:'center', padding:'64px 20px', color:'#9ca3af' }}>
            <div style={{ fontSize:40, marginBottom:12, display:'flex', justifyContent:'center' }}><FaBox /></div>
            <p style={{ fontSize:15, marginBottom:16 }}>No shipments found.</p>
            <Link to="/shipments/new" style={{ color:'#7B3FAD', fontWeight:700, textDecoration:'none', fontSize:14, display:'inline-flex', alignItems:'center', gap:6 }}>Create your first shipment <FaArrowRight size={11} /></Link>
          </div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ borderBottom:'1px solid #f0e8f9', backgroundColor:'#faf5ff' }}>
                  <th style={{ padding:'12px 14px', width:36 }}>
                    <input type="checkbox" checked={shipments.length>0 && selected.size===shipments.length}
                      onChange={toggleSelectAll} style={{ cursor:'pointer' }} />
                  </th>
                  {['GE Number','From','To','Carrier','Wt / Pcs','Status','Date','Actions'].map(h => (
                    <th key={h} style={{ padding:'12px 14px', textAlign:'left', fontWeight:700, color:'#7B3FAD', fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shipments.map((s,idx) => (
                  <tr key={s.id} style={{ borderBottom:'1px solid #faf5ff', backgroundColor:idx%2===0?'white':'#fdf8ff', transition:'background 0.15s' }}
                    onMouseEnter={e=>e.currentTarget.style.backgroundColor='#f5f0ff'}
                    onMouseLeave={e=>e.currentTarget.style.backgroundColor=idx%2===0?'white':'#fdf8ff'}>
                    <td style={{ padding:'13px 14px' }}>
                      <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} style={{ cursor:'pointer' }} />
                    </td>
                    <td style={{ padding:'13px 14px' }}>
                      <div style={{ fontFamily:'monospace', fontWeight:800, color:'#7B3FAD', fontSize:13 }}>{s.ge_tracking_number}</div>
                      {s.garuda_waybill_generated ? <div style={{ fontSize:9, color:'#059669', backgroundColor:'#d1fae5', padding:'1px 6px', borderRadius:50, display:'inline-flex', alignItems:'center', gap:3, marginTop:3, fontWeight:700 }}><FaCheck size={8} /> Waybill</div> : null}
                    </td>
                    <td style={{ padding:'13px 14px' }}>
                      <div style={{ fontWeight:600, color:'#1a0820', maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.from_name || '—'}</div>
                      <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>{[s.from_city,s.from_country].filter(Boolean).join(', ')}</div>
                    </td>
                    <td style={{ padding:'13px 14px' }}>
                      <div style={{ fontWeight:600, color:'#1a0820', maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.to_name || '—'}</div>
                      <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>{[s.to_city,s.to_country].filter(Boolean).join(', ')}</div>
                    </td>
                    <td style={{ padding:'13px 14px', color:'#374151', fontWeight:600 }}>{s.carrier || '—'}</td>
                    <td style={{ padding:'13px 14px', textAlign:'center' }}>
                      <div style={{ color:'#374151', fontWeight:600 }}>{s.billing_weight || s.actual_weight ? `${s.billing_weight||s.actual_weight} kg` : '—'}</div>
                      <div style={{ fontSize:11, color:'#9ca3af' }}>{s.pieces||1} pc{s.pieces!==1?'s':''}</div>
                    </td>
                    <td style={{ padding:'13px 14px' }}><StatusBadge status={s.status} /></td>
                    <td style={{ padding:'13px 14px', color:'#9ca3af', fontSize:12, whiteSpace:'nowrap' }}>{s.ship_date||s.created_at?.slice(0,10)}</td>
                    <td style={{ padding:'13px 14px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                        {/* View */}
                        <Link to={`/shipments/${s.id}`} title="View"
                          style={{ width:32, height:32, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:8, color:'#7B3FAD', backgroundColor:'rgba(123,63,173,0.08)', textDecoration:'none', transition:'all 0.15s' }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        </Link>
                        {/* Edit */}
                        <Link to={`/shipments/${s.id}`} title="Edit"
                          style={{ width:32, height:32, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:8, color:'#3b82f6', backgroundColor:'rgba(59,130,246,0.08)', textDecoration:'none', transition:'all 0.15s' }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </Link>
                        {/* Download waybill */}
                        <button onClick={() => handleDownloadOne(s.id, s.ge_tracking_number)} disabled={downloading} title="Download Waybill"
                          style={{ width:32, height:32, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:8, color:'#059669', backgroundColor:'rgba(5,150,105,0.08)', border:'none', cursor:downloading?'not-allowed':'pointer', transition:'all 0.15s' }}>
                          <FaDownload size={13} />
                        </button>
                        {/* Delete (admin only) */}
                        {isAdmin && (
                          <button onClick={() => handleDelete(s.id, s.ge_tracking_number)} disabled={deleting} title="Delete"
                            style={{ width:32, height:32, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:8, color:'#ef4444', backgroundColor:'rgba(239,68,68,0.08)', border:'none', cursor:'pointer', transition:'all 0.15s' }}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ padding:'12px 16px', borderTop:'1px solid #f0e8f9', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ fontSize:12, color:'#9ca3af' }}>Page {page} of {totalPages} · {total} total</span>
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}
                style={{ padding:'6px 14px', fontSize:12, borderRadius:8, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', cursor:page===1?'default':'pointer', opacity:page===1?0.4:1, display:'inline-flex', alignItems:'center', gap:6 }}>
                <FaArrowLeft size={10} /> Prev
              </button>
              <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages}
                style={{ padding:'6px 14px', fontSize:12, borderRadius:8, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', cursor:page===totalPages?'default':'pointer', opacity:page===totalPages?0.4:1, display:'inline-flex', alignItems:'center', gap:6 }}>
                Next <FaArrowRight size={10} />
              </button>
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }`}</style>
    </AdminLayout>
  )
}