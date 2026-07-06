// src/pages/ShipmentDetail.jsx — View / Edit / Generate Garuda Waybill
import React, { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  FaTriangleExclamation, FaArrowLeft, FaArrowRotateRight, FaFileLines, FaXmark,
  FaCheck, FaPaperPlane, FaInbox, FaClipboardList, FaLock, FaScaleBalanced, FaClock,
  FaSatelliteDish, FaCircleDot,
} from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import LoadingTruck from '../components/LoadingTruck.jsx'
import { useAuth } from '../context/AuthContext.jsx'

const CARRIERS = ['FedEx','UPS','DHL','Aramex','BlueDart','DTDC','Trackon','Delhivery','Ekart','IndiaPost','Xpressbees','Shadowfax','Professional Couriers','TNT','Purolator','Other']
const STATUSES = ['Processing','Picked Up','In Transit','Out for Delivery','Delivered','Exception','Returned']

const inp = { width:'100%', border:'1.5px solid #e5e7eb', borderRadius:10, padding:'9px 14px', fontSize:13, outline:'none', boxSizing:'border-box', fontFamily:'inherit', transition:'border-color 0.2s' }
const lbl = { display:'block', fontSize:9, color:'#9c88bb', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:5, fontWeight:700 }

function Field({ label, value, name, onChange, edit, type='text', options }) {
  if (edit) {
    if (options) return (
      <div>
        <label style={lbl}>{label}</label>
        <select name={name} defaultValue={value||''} onChange={onChange} style={{ ...inp, backgroundColor:'white' }}>
          <option value="">— Select —</option>
          {options.map(o=><option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
    if (type==='textarea') return (
      <div>
        <label style={lbl}>{label}</label>
        <textarea name={name} defaultValue={value||''} onChange={onChange} rows={3} style={{ ...inp, resize:'none' }} />
      </div>
    )
    return (
      <div>
        <label style={lbl}>{label}</label>
        <input type={type} name={name} defaultValue={value||''} onChange={onChange} style={inp} />
      </div>
    )
  }
  return (
    <div>
      <div style={lbl}>{label}</div>
      <div style={{ fontSize:13, fontWeight:value?600:400, color:value?'#1a0820':'#d1d5db', fontStyle:value?'normal':'italic' }}>
        {value || 'Not provided'}
      </div>
    </div>
  )
}

function Card({ title, icon, children, accent }) {
  return (
    <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:`1px solid ${accent||'#f0e8f9'}`, boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
      <h2 style={{ fontSize:11, fontWeight:700, color:'#7B3FAD', textTransform:'uppercase', letterSpacing:'0.14em', marginBottom:20, display:'flex', alignItems:'center', gap:6 }}>
        <span style={{ fontSize:15 }}>{icon}</span> {title}
      </h2>
      {children}
    </div>
  )
}

export default function ShipmentDetail() {
  const { id }   = useParams()
  const navigate = useNavigate()
  const { authFetch, isAdmin } = useAuth()

  const [shipment,  setShipment]  = useState(null)
  const [trackingHistory, setTrackingHistory] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [mode,      setMode]      = useState('view')   // 'view' | 'edit'
  const [saving,    setSaving]    = useState(false)
  const [genLoad,   setGenLoad]   = useState(false)
  const [reprocLoad, setReprocLoad] = useState(false)
  const [refreshLoad, setRefreshLoad] = useState(false)
  const [trackSettings, setTrackSettings] = useState(null) // { auto_tracking_enabled } — independent of the page's Edit/Save
  const [trackSaving, setTrackSaving] = useState(false)
  const [trackSaved, setTrackSaved] = useState(false)
  const [changes,   setChanges]   = useState({})
  const [error,     setError]     = useState(null)
  const [success,   setSuccess]   = useState(null)

  // Guard: must be a valid numeric ID
  useEffect(() => {
    if (!id || isNaN(parseInt(id, 10))) { navigate('/shipments', { replace:true }); return }
    setLoading(true)
    authFetch(`/api/shipments/${id}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setShipment(d.data)
          setTrackingHistory(d.trackingHistory || [])
          setTrackSettings({
            auto_tracking_enabled: !!d.data.auto_tracking_enabled,
          })
        } else setError('Shipment not found')
      })
      .catch(() => setError('Failed to load shipment'))
      .finally(() => setLoading(false))
  }, [id])

  const handleChange = (e) => setChanges(c => ({ ...c, [e.target.name]: e.target.value }))

  const handleSave = async () => {
    if (!Object.keys(changes).length) { setMode('view'); return }
    setSaving(true); setError(null); setSuccess(null)
    try {
      const res  = await authFetch(`/api/shipments/${id}`, {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(changes)
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setShipment(data.data); setMode('view'); setChanges({})
      setSuccess('Saved successfully!')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const handleReprocess = async () => {
    if (!window.confirm('Re-extract this shipment\'s data from the original uploaded file? This will overwrite the current sender/receiver/shipment fields with a fresh OCR pass — any manual edits to those fields will be lost (status and notes are untouched).')) return
    setReprocLoad(true); setError(null); setSuccess(null)
    try {
      const res  = await authFetch(`/api/shipments/${id}/reprocess`, { method:'POST' })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setShipment(data.data)
      setSuccess(`Re-extracted successfully (${data.engine || 'OCR'}, ${Math.round(data.confidence || 0)}% confidence).`)
      setTimeout(() => setSuccess(null), 5000)
    } catch (err) { setError('Reprocess failed: ' + err.message) }
    finally { setReprocLoad(false) }
  }

  const handleGenerateWaybill = async () => {
    setGenLoad(true); setError(null)
    try {
      const res = await authFetch(`/api/shipments/${id}/generate-waybill`, { method:'POST' })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error:'Unknown error' }))
        throw new Error(e.error || 'Generation failed')
      }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `GarudaExpress_${shipment.ge_tracking_number}.pdf`; a.click()
      URL.revokeObjectURL(url)
      setShipment(s => ({ ...s, garuda_waybill_generated:1 }))
      setSuccess('Garuda waybill downloaded!')
      setTimeout(() => setSuccess(null), 4000)
    } catch (err) { setError('Waybill failed: ' + err.message) }
    finally { setGenLoad(false) }
  }

  const handleDelete = async () => {
    if (!window.confirm(`Permanently delete ${shipment?.ge_tracking_number}?`)) return
    await authFetch(`/api/shipments/${id}`, { method:'DELETE' })
    navigate('/shipments')
  }

  // Register Now / Refresh Now — same backend action either way: register
  // with a provider if not done yet, otherwise pull the latest status
  // on-demand. The button label below reflects which one this actually is
  // for a given shipment.
  const handleTrackingRefresh = async () => {
    setRefreshLoad(true); setError(null); setSuccess(null)
    try {
      const res  = await authFetch(`/api/shipments/${id}/tracking/refresh`, { method:'POST' })
      const data = await res.json()
      setShipment(data.data)
      setTrackingHistory(data.trackingHistory || [])
      if (data.success) { setSuccess(data.data?.tracking_registered ? 'Tracking refreshed from carrier providers.' : 'Registered for tracking.'); setTimeout(() => setSuccess(null), 4000) }
      else setError(data.error || 'Could not reach a tracking provider — shipment moved to the manual tracking queue.')
    } catch (err) { setError('Tracking action failed: ' + err.message) }
    finally { setRefreshLoad(false) }
  }

  // Auto Tracking on/off — deliberately independent of the page-wide
  // Edit/Save flow above, so toggling it doesn't require first entering
  // "Edit" mode on the rest of the shipment's fields.
  const handleSaveTrackSettings = async () => {
    setTrackSaving(true); setError(null); setTrackSaved(false)
    try {
      const res  = await authFetch(`/api/shipments/${id}`, {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ auto_tracking_enabled: !!trackSettings.auto_tracking_enabled }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setShipment(data.data)
      setTrackSettings({ auto_tracking_enabled: !!data.data.auto_tracking_enabled })
      setTrackSaved(true); setTimeout(() => setTrackSaved(false), 3000)
    } catch (err) { setError('Could not save tracking settings: ' + err.message) }
    finally { setTrackSaving(false) }
  }

  const merged = { ...shipment, ...changes }

  if (loading) return <AdminLayout><LoadingTruck text="Loading shipment…" /></AdminLayout>

  if (error && !shipment) return (
    <AdminLayout>
      <div style={{ textAlign:'center', padding:'64px 20px' }}>
        <div style={{ fontSize:48, marginBottom:12, color:'#dc2626', display:'flex', justifyContent:'center' }}><FaTriangleExclamation /></div>
        <p style={{ color:'#dc2626', fontSize:15, marginBottom:16 }}>{error}</p>
        <Link to="/shipments" style={{ color:'#7B3FAD', fontWeight:700, textDecoration:'none', display:'inline-flex', alignItems:'center', gap:6 }}><FaArrowLeft size={11} /> Back to Shipments</Link>
      </div>
    </AdminLayout>
  )

  return (
    <AdminLayout>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

      {/* Page header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16, marginBottom:24, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <Link to="/shipments" style={{ width:38, height:38, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:12, border:'1.5px solid #e5e7eb', backgroundColor:'white', textDecoration:'none', color:'#374151' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </Link>
          <div>
            <h1 style={{ fontFamily:'monospace', fontSize:22, fontWeight:800, color:'#7B3FAD', margin:0, letterSpacing:'0.03em' }}>{shipment?.ge_tracking_number}</h1>
            <div style={{ marginTop:4 }}><StatusBadge status={merged.status} /></div>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {mode === 'view' ? (
            <>
              {/* VIEW (already viewing) */}
              <div style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:12, backgroundColor:'rgba(123,63,173,0.08)', color:'#7B3FAD', fontSize:13, fontWeight:700, border:'1.5px solid rgba(123,63,173,0.2)' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                Viewing
              </div>

              {/* EDIT */}
              <button onClick={() => setMode('edit')}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:12, border:'1.5px solid #3b82f6', backgroundColor:'white', color:'#3b82f6', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Edit
              </button>

              {/* REPROCESS — only offered when there's an original file on
                  disk to re-extract from (see backend route's own check). */}
              {shipment?.original_waybill_file && (
                <button onClick={handleReprocess} disabled={reprocLoad} title="Re-run OCR/extraction on the originally uploaded file"
                  style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:12, border:'1.5px solid #2563eb', backgroundColor:'white', color:'#2563eb', fontSize:13, fontWeight:700, cursor:reprocLoad?'not-allowed':'pointer', opacity:reprocLoad?0.7:1 }}>
                  <span style={{ display:'inline-flex', animation:reprocLoad?'spin 0.8s linear infinite':undefined }}>
                    <FaArrowRotateRight size={14} />
                  </span>
                  {reprocLoad ? 'Re-extracting…' : 'Reprocess'}
                </button>
              )}

              {/* GENERATE */}
              <button onClick={handleGenerateWaybill} disabled={genLoad}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:12, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', fontSize:13, fontWeight:700, border:'none', cursor:genLoad?'not-allowed':'pointer', opacity:genLoad?0.7:1, boxShadow:'0 4px 12px rgba(123,63,173,0.25)' }}>
                <span style={{ display:'inline-flex', animation:genLoad?'spin 0.8s linear infinite':undefined }}>
                  {genLoad ? <FaArrowRotateRight size={14} /> : <FaFileLines size={14} />}
                </span>
                {merged.garuda_waybill_generated ? 'Re-generate Waybill' : 'Generate Waybill'}
              </button>

              {/* DELETE */}
              {isAdmin && (
                <button onClick={handleDelete}
                  style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:12, border:'1.5px solid #fca5a5', backgroundColor:'white', color:'#dc2626', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                  Delete
                </button>
              )}
            </>
          ) : (
            /* EDITING MODE buttons */
            <>
              <button onClick={() => { setMode('view'); setChanges({}) }}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:12, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                <FaXmark size={13} /> Cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:12, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', fontSize:13, fontWeight:700, border:'none', cursor:saving?'not-allowed':'pointer', opacity:saving?0.7:1 }}>
                <span style={{ display:'inline-flex', animation:saving?'spin 0.8s linear infinite':undefined }}>{saving?<FaArrowRotateRight size={13}/>:<FaCheck size={13}/>}</span>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Alerts */}
      {error   && <div style={{ backgroundColor:'#fef2f2', border:'1px solid #fca5a5', color:'#dc2626', borderRadius:12, padding:'12px 16px', marginBottom:16, fontSize:13, display:'flex', alignItems:'center', gap:8 }}><FaTriangleExclamation size={13} /> {error}</div>}
      {success && <div style={{ backgroundColor:'#f0fdf4', border:'1px solid #a7f3d0', color:'#059669', borderRadius:12, padding:'12px 16px', marginBottom:16, fontSize:13, display:'flex', alignItems:'center', gap:8 }}><FaCheck size={13} /> {success}</div>}

      {/* GE number badge */}
      <div style={{ backgroundColor:'rgba(123,63,173,0.06)', border:'1px solid rgba(123,63,173,0.2)', borderRadius:16, padding:'14px 20px', marginBottom:20, display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
        <div>
          <div style={{ fontSize:9, color:'#7B3FAD', textTransform:'uppercase', letterSpacing:'0.15em', fontWeight:700, marginBottom:4 }}>Garuda Express Tracking</div>
          <div style={{ fontFamily:'monospace', fontSize:22, fontWeight:800, color:'#1a0820', letterSpacing:'0.05em' }}>{shipment?.ge_tracking_number}</div>
        </div>
        <div style={{ textAlign:'right' }}>
          {shipment?.garuda_waybill_generated ? (
            <span style={{ backgroundColor:'#d1fae5', color:'#065f46', padding:'4px 12px', borderRadius:50, fontSize:11, fontWeight:700, display:'inline-flex', alignItems:'center', gap:6 }}><FaFileLines size={11} /> Waybill Generated</span>
          ) : (
            <span style={{ backgroundColor:'#fef3c7', color:'#92400e', padding:'4px 12px', borderRadius:50, fontSize:11, fontWeight:700, display:'inline-flex', alignItems:'center', gap:6 }}><FaClock size={11} /> Waybill Pending</span>
          )}
          <div style={{ fontSize:11, color:'#9ca3af', marginTop:6 }}>ID: #{shipment?.id} · Created: {shipment?.created_at?.slice(0,10)}</div>
        </div>
      </div>

      {/* Main grid */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', gap:20 }} className="detail-grid">

        {/* LEFT */}
        <div style={{ display:'flex', flexDirection:'column', gap:20 }}>

          {/* FROM */}
          <Card title="Sender / From" icon={<FaPaperPlane />}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              <Field label="Name"    name="from_name"    value={merged.from_name}    edit={mode==='edit'} onChange={handleChange} />
              <Field label="Phone"   name="from_contact" value={merged.from_contact} edit={mode==='edit'} onChange={handleChange} type="tel" />
              <Field label="Address" name="from_address" value={merged.from_address} edit={mode==='edit'} onChange={handleChange} />
              <Field label="City"    name="from_city"    value={merged.from_city}    edit={mode==='edit'} onChange={handleChange} />
              <Field label="State"   name="from_state"   value={merged.from_state}   edit={mode==='edit'} onChange={handleChange} />
              <Field label="Country" name="from_country" value={merged.from_country} edit={mode==='edit'} onChange={handleChange} />
              <Field label="Postal"  name="from_postal"  value={merged.from_postal}  edit={mode==='edit'} onChange={handleChange} />
            </div>
          </Card>

          {/* TO */}
          <Card title="Recipient / To" icon={<FaInbox />} accent="#e0f2fe">
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              <Field label="Name"    name="to_name"    value={merged.to_name}    edit={mode==='edit'} onChange={handleChange} />
              <Field label="Phone"   name="to_contact" value={merged.to_contact} edit={mode==='edit'} onChange={handleChange} type="tel" />
              <Field label="Address" name="to_address" value={merged.to_address} edit={mode==='edit'} onChange={handleChange} />
              <Field label="City"    name="to_city"    value={merged.to_city}    edit={mode==='edit'} onChange={handleChange} />
              <Field label="State"   name="to_state"   value={merged.to_state}   edit={mode==='edit'} onChange={handleChange} />
              <Field label="Country" name="to_country" value={merged.to_country} edit={mode==='edit'} onChange={handleChange} />
              <Field label="Postal"  name="to_postal"  value={merged.to_postal}  edit={mode==='edit'} onChange={handleChange} />
            </div>
          </Card>

          {/* Contents */}
          <Card title="Contents & Instructions" icon={<FaClipboardList />}>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <Field label="Description / Contents"  name="contents"             value={merged.contents}             edit={mode==='edit'} onChange={handleChange} type="textarea" />
              <Field label="Special Instructions"    name="special_instructions" value={merged.special_instructions} edit={mode==='edit'} onChange={handleChange} type="textarea" />
            </div>
          </Card>
        </div>

        {/* RIGHT sidebar */}
        <div style={{ display:'flex', flexDirection:'column', gap:20 }}>

          {/* Carrier — admin only */}
          {isAdmin && (
            <Card title="Carrier (Admin)" icon={<FaLock />} accent="#fef3c7">
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <Field label="Carrier"            name="carrier"                 value={merged.carrier}                 edit={mode==='edit'} onChange={handleChange} options={CARRIERS} />
                <Field label="Carrier Tracking #" name="carrier_tracking_number" value={merged.carrier_tracking_number} edit={mode==='edit'} onChange={handleChange} />
                <Field label="Vendor"             name="vendor"                  value={merged.vendor}                  edit={mode==='edit'} onChange={handleChange} />
                <Field label="Invoice Number"     name="invoice_number"          value={merged.invoice_number}          edit={mode==='edit'} onChange={handleChange} />
              </div>
            </Card>
          )}

          {/* Auto Tracking — admin only. Registers this shipment with
              TrackingMore/17Track ONE TIME (Register Now / Refresh Now
              button below); after that, the provider tracks it on its own
              and pushes updates via webhook — see
              services/trackingService.js. This page only ever reads the
              backend-stored result (getStoredTracking), never a live API
              call. Deliberately always editable here, independent of the
              page's main Edit/Save toggle above. */}
          {isAdmin && trackSettings && (
            <Card title="Auto Tracking" icon={<FaSatelliteDish />} accent="#e0f2fe">
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <div>
                  <label style={lbl}>Auto Tracking</label>
                  <select
                    value={trackSettings.auto_tracking_enabled ? '1' : '0'}
                    onChange={e => setTrackSettings(s => ({ ...s, auto_tracking_enabled: e.target.value === '1' }))}
                    style={{ ...inp, backgroundColor:'white' }}>
                    <option value="1">Enabled</option>
                    <option value="0">Disabled</option>
                  </select>
                </div>

                <button onClick={handleSaveTrackSettings} disabled={trackSaving}
                  style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'9px 14px', borderRadius:10, border:'none', backgroundColor: trackSaved ? '#059669' : '#7B3FAD', color:'white', fontSize:12, fontWeight:700, cursor:trackSaving?'not-allowed':'pointer', opacity:trackSaving?0.6:1 }}>
                  {trackSaving ? <FaArrowRotateRight size={12} style={{ animation:'spin 0.8s linear infinite' }} /> : trackSaved ? <FaCheck size={12} /> : null}
                  {trackSaving ? 'Saving…' : trackSaved ? 'Saved' : 'Save'}
                </button>

                <div>
                  <div style={lbl}>Registration Status</div>
                  {merged.tracking_registered ? (
                    <span style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, fontWeight:700, padding:'4px 10px', borderRadius:50, backgroundColor:'#d1fae5', color:'#065f46' }}>
                      <FaCircleDot size={7} /> Registered via {merged.carrier_code_provider === '17track' ? '17Track' : 'TrackingMore'}
                    </span>
                  ) : (
                    <span style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, fontWeight:700, padding:'4px 10px', borderRadius:50, backgroundColor:'#f3f4f6', color:'#6b7280' }}>
                      <FaCircleDot size={7} /> Not registered yet
                    </span>
                  )}
                  <div style={{ fontSize:11, color:'#9ca3af', marginTop:6 }}>
                    Registered once with a provider, which then tracks it on its own and pushes updates here — no repeated checking needed.
                  </div>
                </div>

                <div>
                  <div style={lbl}>Last Update</div>
                  <div style={{ fontSize:13, fontWeight:600, color: merged.last_tracking_update ? '#1a0820' : '#d1d5db', fontStyle: merged.last_tracking_update ? 'normal' : 'italic' }}>
                    {merged.last_tracking_update ? merged.last_tracking_update.slice(0,16).replace('T',' ') : 'None yet'}
                  </div>
                  {merged.needs_manual_tracking ? (
                    <div style={{ marginTop:8, padding:'8px 10px', borderRadius:8, backgroundColor:'#fffbeb', border:'1px solid #fde68a' }}>
                      <div style={{ fontSize:11, color:'#92400e', fontWeight:700 }}>⚠ Routed to manual tracking queue</div>
                      {merged.registration_error && (
                        <div style={{ fontSize:11, color:'#92400e', marginTop:4, lineHeight:1.5 }}>{merged.registration_error}</div>
                      )}
                    </div>
                  ) : null}
                </div>

                <button onClick={handleTrackingRefresh} disabled={refreshLoad || !merged.carrier_tracking_number}
                  title={!merged.carrier_tracking_number ? 'Add a Carrier Tracking # first' : merged.tracking_registered ? 'Check the latest status from TrackingMore/17Track now' : 'Register this shipment with a tracking provider now'}
                  style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'9px 14px', borderRadius:10, border:'1.5px solid #7B3FAD', backgroundColor:'white', color:'#7B3FAD', fontSize:12, fontWeight:700, cursor:(refreshLoad || !merged.carrier_tracking_number)?'not-allowed':'pointer', opacity:(refreshLoad || !merged.carrier_tracking_number)?0.5:1 }}>
                  <span style={{ display:'inline-flex', animation:refreshLoad?'spin 0.8s linear infinite':undefined }}><FaArrowRotateRight size={12} /></span>
                  {refreshLoad ? 'Working…' : merged.tracking_registered ? 'Refresh Now' : 'Register Now'}
                </button>

                {trackingHistory.length > 0 && (
                  <div>
                    <div style={lbl}>Tracking History</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:8, maxHeight:220, overflowY:'auto', paddingRight:4 }}>
                      {trackingHistory.map((ev, i) => (
                        <div key={i} style={{ fontSize:11, borderLeft:'2px solid #e9d5ff', paddingLeft:10 }}>
                          <div style={{ fontWeight:700, color:'#1a0820' }}>{ev.status || '—'}</div>
                          <div style={{ color:'#9ca3af' }}>{ev.location ? `${ev.location} · ` : ''}{ev.event_timestamp ? String(ev.event_timestamp).slice(0,16).replace('T',' ') : ''}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Shipment specs */}
          <Card title="Shipment Details" icon={<FaScaleBalanced />}>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <Field label="Status"              name="status"         value={merged.status}         edit={mode==='edit'} onChange={handleChange} options={STATUSES} />
              <Field label="Ship Date"           name="ship_date"      value={merged.ship_date}      edit={mode==='edit'} onChange={handleChange} type="date" />
              <Field label="Pieces"              name="pieces"         value={merged.pieces}         edit={mode==='edit'} onChange={handleChange} type="number" />
              <Field label="Actual Weight (kg)"  name="actual_weight"  value={merged.actual_weight}  edit={mode==='edit'} onChange={handleChange} type="number" />
              <Field label="Billing Weight (kg)" name="billing_weight" value={merged.billing_weight} edit={mode==='edit'} onChange={handleChange} type="number" />
              <Field label="Dimensions"          name="dimensions"     value={merged.dimensions}     edit={mode==='edit'} onChange={handleChange} />
              <Field label="Declared Value"      name="declared_value" value={merged.declared_value} edit={mode==='edit'} onChange={handleChange} type="number" />
              <Field label="Currency"            name="currency"       value={merged.currency}       edit={mode==='edit'} onChange={handleChange} />
            </div>
          </Card>

          {/* Audit */}
          <div style={{ backgroundColor:'#faf5ff', borderRadius:14, padding:14, border:'1px solid #f0e8f9', fontSize:11, color:'#9ca3af', lineHeight:1.8 }}>
            <div>ID: #{shipment?.id}</div>
            <div>Created: {shipment?.created_at?.slice(0,16).replace('T',' ')}</div>
            <div>Updated: {shipment?.updated_at?.slice(0,16).replace('T',' ')}</div>
            {shipment?.ocr_confidence && <div>OCR: {shipment.ocr_confidence.toFixed(0)}% confidence</div>}
          </div>
        </div>
      </div>

      <style>{`.detail-grid{grid-template-columns:1fr!important} @media(min-width:900px){.detail-grid{grid-template-columns:1fr 300px!important}}`}</style>
    </AdminLayout>
  )
}