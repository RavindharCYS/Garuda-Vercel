// src/pages/BulkUploadPage.jsx — Bulk OCR with View / Edit / Generate workflow
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  FaCheck, FaXmark, FaArrowRotateRight, FaCloudArrowUp, FaTriangleExclamation,
  FaCamera, FaFolderOpen, FaMagnifyingGlass, FaInbox, FaFileExcel, FaDownload,
} from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { downloadWaybill, confirmAndDownloadWaybills } from '../utils/waybillDownload.js'

const ALLOWED = ['image/png','image/jpeg','image/jpg','image/tiff','image/webp','application/pdf']

const CARRIERS = ['FedEx','UPS','DHL','Aramex','BlueDart','DTDC','Trackon','Delhivery','Ekart','IndiaPost','Xpressbees','Shadowfax','Professional Couriers','TNT','Purolator','Other']

// ── Field row for view/edit ───────────────────────────────────────────────────
function FieldRow({ label, value, name, onChange, editing, type='text' }) {
  return (
    <div>
      <div style={{ fontSize:9, color:'#9c88bb', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:4, fontWeight:700 }}>{label}</div>
      {editing ? (
        type === 'select' ? (
          <select name={name} value={value||''} onChange={onChange}
            style={{ width:'100%', border:'1px solid #ddd', borderRadius:8, padding:'6px 10px', fontSize:13, outline:'none', backgroundColor:'white' }}>
            <option value="">— Select —</option>
            {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : (
          <input type={type} name={name} value={value||''} onChange={onChange}
            style={{ width:'100%', border:'1px solid #ddd', borderRadius:8, padding:'6px 10px', fontSize:13, outline:'none', boxSizing:'border-box' }} />
        )
      ) : (
        <div style={{ fontSize:13, color: value ? '#1a0820' : '#ccc', fontStyle: value ? 'normal' : 'italic', fontWeight: value ? 500 : 400 }}>
          {value || 'Not detected'}
        </div>
      )}
    </div>
  )
}

// Normalizes a raw OCR `fields` payload into what the form/UI expects:
//  - actual_weight falls back to billing_weight (and the fallback is written
//    back into the object, so what's displayed is also what gets saved)
function normalizeOcrFields(raw) {
  const f = { ...raw }

  if ((f.actual_weight === undefined || f.actual_weight === null) && f.billing_weight != null) {
    f.actual_weight = f.billing_weight
  }

  return f
}

// ── Single file card with View / Edit / Generate ──────────────────────────────
function FileCard({ item, onSave, onDiscard, onGenerate }) {
  const { file, result, saved, saving, generating, cardError } = item
  const [mode,   setMode]   = useState('view')   // 'view' | 'edit'
  const [fields, setFields] = useState({})

  // `result` arrives asynchronously after OCR finishes. Because this card is
  // keyed by item.id (which doesn't change), React reuses the same FileCard
  // instance rather than remounting it — so the old `useState(result?.fields
  // || {})` only ever ran once, while result was still null. This effect
  // re-syncs `fields` every time a real OCR result comes in.
  useEffect(() => {
    if (result?.fields) {
      setFields(normalizeOcrFields(result.fields))
    }
  }, [result])

  const setF = (e) => setFields(f => ({ ...f, [e.target.name]: e.target.value }))

  const status = saved ? 'saved' : cardError ? 'error' : result ? 'ready' : 'pending'

  const headerBg = {
    saved:   '#ecfdf5', error: '#fef2f2',
    ready:   '#f5f0ff', pending: '#f9fafb',
  }
  const headerBorder = {
    saved:   '#a7f3d0', error: '#fca5a5',
    ready:   '#ddd6fe', pending: '#e5e7eb',
  }

  return (
    <div style={{ borderRadius:20, border:`1px solid ${headerBorder[status]}`, overflow:'hidden', backgroundColor:'white', boxShadow:'0 1px 4px rgba(0,0,0,0.06)' }}>
      {/* Header */}
      <div style={{ backgroundColor:headerBg[status], padding:'14px 18px', borderBottom:`1px solid ${headerBorder[status]}`, display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ flexShrink:0 }}>
          {status === 'saved'   && <span style={{ color:'#10b981', fontSize:20, display:'flex' }}><FaCheck size={18} /></span>}
          {status === 'error'   && <span style={{ color:'#ef4444', fontSize:20, display:'flex' }}><FaXmark size={18} /></span>}
          {status === 'ready'   && <span style={{ color:'#7B3FAD', fontSize:20 }}>◉</span>}
          {status === 'pending' && <span style={{ color:'#9ca3af', fontSize:20 }}>○</span>}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'#1a0820', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{file.name}</div>
          <div style={{ fontSize:11, color:'#666', marginTop:2 }}>
            {status === 'saved'   && <span style={{ display:'inline-flex', alignItems:'center', gap:4 }}><FaCheck size={9} /> Created: {saved}</span>}
            {status === 'error'   && (cardError || 'OCR failed')}
            {status === 'ready'   && `OCR complete — ${result?.confidence?.toFixed(0)}% confidence · Rotation: ${result?.rotation_applied || 0}°`}
            {status === 'pending' && 'Queued for scanning…'}
          </div>
        </div>
        {status !== 'saved' && (
          <button onClick={onDiscard} style={{ background:'none', border:'none', color:'#9ca3af', cursor:'pointer', fontSize:18, padding:'0 4px', lineHeight:1, display:'flex' }}><FaXmark size={16} /></button>
        )}
      </div>

      {/* Content when ready */}
      {status === 'ready' && (
        <div style={{ padding:18 }}>
          {/* Action buttons */}
          <div style={{ display:'flex', gap:8, marginBottom:18, flexWrap:'wrap' }}>
            <button onClick={() => setMode('view')}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', borderRadius:10, border:`1.5px solid ${mode==='view'?'#7B3FAD':'#e5e7eb'}`, backgroundColor:mode==='view'?'#f5f0ff':'white', color:mode==='view'?'#7B3FAD':'#666', fontSize:12, fontWeight:700, cursor:'pointer' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              View
            </button>
            <button onClick={() => setMode('edit')}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', borderRadius:10, border:`1.5px solid ${mode==='edit'?'#3b82f6':'#e5e7eb'}`, backgroundColor:mode==='edit'?'#eff6ff':'white', color:mode==='edit'?'#3b82f6':'#666', fontSize:12, fontWeight:700, cursor:'pointer' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>

            {/* Save to DB button */}
            <button onClick={() => onSave(fields, result.filename)} disabled={saving}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', borderRadius:10, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', fontSize:12, fontWeight:700, border:'none', cursor: saving?'not-allowed':'pointer', opacity:saving?0.6:1, marginLeft:'auto' }}>
              {saving
                ? <><FaArrowRotateRight size={13} style={{ animation:'spin 0.8s linear infinite' }} /> Saving…</>
                : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Shipment</>}
            </button>
          </div>

          {/* Fields grid */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(180px, 1fr))', gap:14 }}>
            <FieldRow label="From Name"      name="from_name"              value={fields.from_name}              editing={mode==='edit'} onChange={setF} />
            <FieldRow label="From Phone"     name="from_contact"           value={fields.from_contact}           editing={mode==='edit'} onChange={setF} />
            <FieldRow label="From City"      name="from_city"              value={fields.from_city}              editing={mode==='edit'} onChange={setF} />
            <FieldRow label="From Country"   name="from_country"           value={fields.from_country}           editing={mode==='edit'} onChange={setF} />
            <FieldRow label="To Name"        name="to_name"                value={fields.to_name}                editing={mode==='edit'} onChange={setF} />
            <FieldRow label="To Phone"       name="to_contact"             value={fields.to_contact}             editing={mode==='edit'} onChange={setF} />
            <FieldRow label="To City"        name="to_city"                value={fields.to_city}                editing={mode==='edit'} onChange={setF} />
            <FieldRow label="To Country"     name="to_country"             value={fields.to_country}             editing={mode==='edit'} onChange={setF} />
            <FieldRow label="Carrier"        name="carrier"                value={fields.carrier}                editing={mode==='edit'} onChange={setF} type="select" />
            <FieldRow label="Tracking #"     name="carrier_tracking_number" value={fields.carrier_tracking_number} editing={mode==='edit'} onChange={setF} />
            <FieldRow label="Weight (kg)"    name="actual_weight"          value={fields.actual_weight}          editing={mode==='edit'} onChange={setF} type="number" />
            <FieldRow label="Ship Date"      name="ship_date"              value={fields.ship_date}              editing={mode==='edit'} onChange={setF} />
            <FieldRow label="Contents"       name="contents"               value={fields.contents}               editing={mode==='edit'} onChange={setF} />
          </div>
        </div>
      )}

      {/* Saved state — show generate button */}
      {status === 'saved' && (
        <div style={{ padding:'14px 18px', backgroundColor:'#f0fdf4', display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
          <div>
            <span style={{ color:'#059669', fontFamily:'monospace', fontWeight:700, fontSize:15 }}>{saved}</span>
            <span style={{ color:'#6ee7b7', fontSize:12, marginLeft:8 }}>Shipment created</span>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => onGenerate(saved)}
              disabled={generating}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', borderRadius:10, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', fontSize:12, fontWeight:700, border:'none', cursor:'pointer', opacity:generating?0.6:1 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              {generating ? 'Generating…' : 'Generate Garuda Waybill'}
            </button>
            <Link to="/shipments"
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', borderRadius:10, border:'1.5px solid #7B3FAD', color:'#7B3FAD', fontSize:12, fontWeight:700, textDecoration:'none' }}>
              View All
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// ── NEW: Bulk Import tab — CSV/Excel/ZIP/PDF-batch via /api/bulk-upload ───────
function BulkImportTab() {
  const { authFetch } = useAuth()
  const inputRef = useRef()
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [job, setJob] = useState(null)
  const [records, setRecords] = useState([])
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [recentJobs, setRecentJobs] = useState([])

  const loadRecentJobs = () => {
    authFetch('/api/bulk-upload').then(r=>r.json()).then(d=>{ if(d.success) setRecentJobs(d.data.slice(0,5)) })
  }
  React.useEffect(loadRecentJobs, [])

  const handleUpload = async () => {
    if (!file) return
    setUploading(true); setError(''); setJob(null); setRecords([])
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await authFetch('/api/bulk-upload', { method:'POST', body:fd })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Upload failed')
      setJob(data.job)
      setRecords(data.records)
      loadRecentJobs()
    } catch (err) { setError(err.message) }
    finally { setUploading(false) }
  }

  const handleImport = async () => {
    if (!job) return
    setImporting(true)
    try {
      const res = await authFetch(`/api/bulk-upload/${job.id}/import`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ skipInvalid:true }) })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setJob(j => ({ ...j, status:'Imported' }))
      loadRecentJobs()
      const ids = (data.shipments || []).map(s => s.id)
      if (ids.length) {
        try { await confirmAndDownloadWaybills(authFetch, ids) }
        catch (err) { setError('Waybill generation failed: ' + err.message) }
      }
    } catch (err) { setError(err.message) }
    finally { setImporting(false) }
  }

  const validCount = records.filter(r => r.validation_status === 'Valid').length
  const invalidCount = records.filter(r => r.validation_status === 'Invalid').length

  return (
    <div>
      <div
        onClick={()=>inputRef.current?.click()}
        style={{ border:'2px dashed #d8b4fe', borderRadius:20, padding:'40px 24px', textAlign:'center', marginBottom:20, cursor:'pointer', backgroundColor:'white' }}>
        <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,.zip,.pdf" onChange={e=>setFile(e.target.files[0])} style={{ display:'none' }} />
        <div style={{ fontSize:28, marginBottom:10, color:'#7B3FAD', display:'flex', justifyContent:'center' }}><FaCloudArrowUp size={26} /></div>
        <div style={{ fontSize:15, fontWeight:700, color:'#1a0820', marginBottom:6 }}>
          {file ? file.name : 'Choose a CSV, Excel, ZIP, or PDF file'}
        </div>
        <div style={{ fontSize:12, color:'#888' }}>CSV/Excel = shipment rows · ZIP = batch of waybill images/PDFs · Max 50MB</div>
      </div>

      <div style={{ display:'flex', justifyContent:'center', marginBottom:24 }}>
        <button onClick={handleUpload} disabled={!file || uploading}
          style={{ padding:'13px 32px', borderRadius:14, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', fontSize:14, fontWeight:800, border:'none', cursor:(!file||uploading)?'not-allowed':'pointer', opacity:(!file||uploading)?0.6:1 }}>
          {uploading ? 'Uploading & Processing…' : 'Upload & Validate'}
        </button>
      </div>

      {error && <div style={{ backgroundColor:'#fef2f2', border:'1px solid #fca5a5', color:'#dc2626', borderRadius:12, padding:'12px 16px', marginBottom:20, fontSize:13, display:'flex', alignItems:'center', gap:8 }}><FaTriangleExclamation size={13} /> {error}</div>}

      {job && (
        <div style={{ backgroundColor:'white', borderRadius:20, border:'1px solid #f0e8f9', overflow:'hidden', marginBottom:24 }}>
          <div style={{ padding:'16px 20px', borderBottom:'1px solid #f0e8f9', display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
            <div>
              <div style={{ fontWeight:700, color:'#1a0820', fontSize:14 }}>{job.file_name}</div>
              <div style={{ fontSize:12, color:'#9ca3af' }}>{records.length} rows · {validCount} valid · {invalidCount} need review</div>
            </div>
            {job.status === 'Imported' ? (
              <span style={{ backgroundColor:'rgba(5,150,105,0.1)', color:'#059669', padding:'6px 16px', borderRadius:50, fontSize:12, fontWeight:700, display:'inline-flex', alignItems:'center', gap:6 }}><FaCheck size={11} /> Imported</span>
            ) : (
              <button onClick={handleImport} disabled={importing || validCount===0}
                style={{ padding:'10px 22px', borderRadius:12, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', fontSize:13, fontWeight:700, cursor:(importing||validCount===0)?'not-allowed':'pointer', opacity:(importing||validCount===0)?0.6:1 }}>
                {importing ? 'Importing…' : `Import ${validCount} Valid Row(s)`}
              </button>
            )}
          </div>
          <div style={{ overflowX:'auto', maxHeight:420, overflowY:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead>
                <tr style={{ backgroundColor:'#faf5ff', position:'sticky', top:0 }}>
                  {['#','Carrier','Tracking #','To','Status','Issues'].map(h => (
                    <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:700, color:'#7B3FAD', fontSize:10, textTransform:'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map(r => (
                  <tr key={r.id} style={{ borderBottom:'1px solid #faf5ff' }}>
                    <td style={{ padding:'10px 14px', color:'#9ca3af' }}>{r.row_number}</td>
                    <td style={{ padding:'10px 14px' }}>{r.raw_data?.carrier || r.detected_carrier || '—'}</td>
                    <td style={{ padding:'10px 14px', fontFamily:'monospace' }}>{r.raw_data?.carrier_tracking_number || '—'}</td>
                    <td style={{ padding:'10px 14px' }}>{r.raw_data?.to_name || '—'}{r.raw_data?.to_country ? `, ${r.raw_data.to_country}` : ''}</td>
                    <td style={{ padding:'10px 14px' }}>
                      <span style={{ fontWeight:700, fontSize:10, textTransform:'uppercase', color: r.validation_status==='Valid' ? '#059669' : r.validation_status==='Imported' ? '#7B3FAD' : '#dc2626' }}>
                        {r.validation_status}
                      </span>
                    </td>
                    <td style={{ padding:'10px 14px', color:'#9ca3af', maxWidth:240 }}>
                      {[...(r.validation_errors||[]), ...(r.validation_warnings||[])].join('; ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {recentJobs.length > 0 && (
        <div>
          <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:12 }}>Recent Upload Jobs</h2>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {recentJobs.map(j => (
              <div key={j.id} style={{ display:'flex', justifyContent:'space-between', backgroundColor:'white', borderRadius:12, padding:'10px 16px', border:'1px solid #f0e8f9', fontSize:12 }}>
                <span style={{ fontWeight:600, color:'#374151' }}>{j.file_name}</span>
                <span style={{ color:'#9ca3af' }}>{j.success_count} imported · {j.failed_count} failed · {j.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── NEW: Excel Upload tab — vendor-specific Excel import (ICL / World First) ──
// Distinct from BulkImportTab above: that one does generic column-alias
// guessing for any CSV/Excel/ZIP. This one implements the requirement doc's
// dedicated ICL / World First pipeline (POST /api/shipments/import-excel),
// including the "Forwading No" -> Tracking Number rule, duplicate skip
// reporting, and per-row Garuda Waybill generation.
const VENDORS = ['ICL', 'World First']

function downloadSkippedRowsCsv(vendor, skippedRows) {
  const header = 'Row,Tracking Number,Reason\n'
  const body = skippedRows.map(r =>
    `${r.row},"${(r.trackingNumber || '').replace(/"/g,'""')}","${(r.reason || '').replace(/"/g,'""')}"`
  ).join('\n')
  const blob = new Blob([header + body], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `${vendor.replace(/\s+/g,'_')}_skipped_rows_${Date.now()}.csv`; a.click()
  URL.revokeObjectURL(url)
}

// One row of the "Pending — Fill in Required Fields" queue: lets the admin
// correct the Tracking Number / Shipper Name / Consignee Name that were
// missing (or fix a duplicate tracking number) and submit to create the
// shipment, without re-uploading the whole file.
function PendingRowFixForm({ jobId, row }) {
  const { authFetch } = useAuth()
  const [fields, setFields] = useState({
    carrier_tracking_number: row.trackingNumber || '',
    from_name: '', to_name: '',
  })
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(null) // { ge_tracking_number } once completed
  const [error, setError] = useState('')

  const submit = async () => {
    setSaving(true); setError('')
    try {
      const res = await authFetch(`/api/bulk-upload/${jobId}/records/${row.recordId}/complete`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(fields),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Could not complete this row')
      setDone(data.shipment)
      if (data.shipment?.id) {
        try { await confirmAndDownloadWaybills(authFetch, [data.shipment.id]) }
        catch (err) { setError('Waybill generation failed: ' + err.message) }
      }
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  if (done) {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 14px', borderRadius:12, backgroundColor:'#f0fdf4', border:'1px solid #bbf7d0', fontSize:12 }}>
        <FaCheck size={12} color="#059669" />
        <span style={{ color:'#065f46', fontWeight:700 }}>Row {row.row} imported as {done.ge_tracking_number}</span>
      </div>
    )
  }

  return (
    <div style={{ padding:14, borderRadius:12, border:'1px solid #f0e8f9', backgroundColor:'#faf5ff' }}>
      <div style={{ fontSize:11, color:'#9ca3af', marginBottom:8 }}>Row {row.row} — <span style={{ color:'#dc2626' }}>{row.reason}</span></div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:8, marginBottom:8 }}>
        <input placeholder="Tracking Number" value={fields.carrier_tracking_number}
          onChange={e=>setFields(f=>({ ...f, carrier_tracking_number: e.target.value }))}
          style={{ border:'1.5px solid #e5e7eb', borderRadius:8, padding:'8px 10px', fontSize:12, outline:'none' }} />
        <input placeholder="Shipper Name" value={fields.from_name}
          onChange={e=>setFields(f=>({ ...f, from_name: e.target.value }))}
          style={{ border:'1.5px solid #e5e7eb', borderRadius:8, padding:'8px 10px', fontSize:12, outline:'none' }} />
        <input placeholder="Consignee Name" value={fields.to_name}
          onChange={e=>setFields(f=>({ ...f, to_name: e.target.value }))}
          style={{ border:'1.5px solid #e5e7eb', borderRadius:8, padding:'8px 10px', fontSize:12, outline:'none' }} />
      </div>
      {error && <div style={{ fontSize:11, color:'#dc2626', marginBottom:8 }}>{error}</div>}
      <button onClick={submit} disabled={saving}
        style={{ padding:'7px 14px', borderRadius:8, border:'none', backgroundColor:'#7B3FAD', color:'white', fontSize:11, fontWeight:700, cursor:saving?'not-allowed':'pointer', opacity:saving?0.6:1 }}>
        {saving ? 'Saving…' : 'Complete Import'}
      </button>
    </div>
  )
}

function VendorExcelImportTab() {
  const { authFetch } = useAuth()
  const inputRef = useRef()
  const [vendor, setVendor] = useState('')
  const [file, setFile] = useState(null)
  const [autoTracking, setAutoTracking] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const handleFileChange = (e) => {
    setFile(e.target.files?.[0] || null)
    setResult(null); setError('')
  }

  const handleImport = async () => {
    if (!vendor || !file) return
    setUploading(true); setError(''); setResult(null)
    const fd = new FormData()
    fd.append('vendor', vendor)
    fd.append('file', file)
    fd.append('auto_tracking_enabled', autoTracking ? '1' : '0')
    try {
      const res = await authFetch('/api/shipments/import-excel', { method:'POST', body:fd })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Import failed')
      setResult(data)
      const ids = (data.shipments || []).map(s => s.id)
      if (ids.length) {
        try { await confirmAndDownloadWaybills(authFetch, ids) }
        catch (err) { setError('Waybill generation failed: ' + err.message) }
      }
    } catch (err) { setError(err.message) }
    finally { setUploading(false) }
  }

  const reset = () => { setFile(null); setResult(null); setError(''); if (inputRef.current) inputRef.current.value = '' }

  return (
    <div>
      {/* Step 1 — Select Vendor */}
      <div style={{ backgroundColor:'white', borderRadius:20, border:'1px solid #f0e8f9', padding:24, marginBottom:20 }}>
        <label style={{ display:'block', fontSize:9, color:'#9c88bb', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:8, fontWeight:700 }}>Vendor</label>
        <select value={vendor} onChange={e=>{ setVendor(e.target.value); setResult(null); setError('') }}
          style={{ width:'100%', maxWidth:320, border:'1.5px solid #e5e7eb', borderRadius:10, padding:'10px 14px', fontSize:14, outline:'none', backgroundColor:'white', fontWeight:600, color:'#1a0820', marginBottom:18 }}>
          <option value="">— Select Vendor —</option>
          {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
        </select>

        <div>
          <label style={{ display:'block', fontSize:9, color:'#9c88bb', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:8, fontWeight:700 }}>Auto Tracking</label>
          <select value={autoTracking ? '1':'0'} onChange={e=>setAutoTracking(e.target.value==='1')}
            style={{ width:180, border:'1.5px solid #e5e7eb', borderRadius:10, padding:'10px 14px', fontSize:13, outline:'none', backgroundColor:'white', fontWeight:600, color:'#1a0820' }}>
            <option value="1">Enabled</option>
            <option value="0">Disabled</option>
          </select>
        </div>
        <div style={{ fontSize:11, color:'#9ca3af', marginTop:10 }}>
          Each shipment is registered with a tracking provider once, right when it's created — the provider then tracks it automatically from there.
        </div>
      </div>

      {/* Step 2 — Upload Excel (only once a vendor is chosen) */}
      {vendor && (
        <div
          onClick={()=>inputRef.current?.click()}
          style={{ border:'2px dashed #d8b4fe', borderRadius:20, padding:'40px 24px', textAlign:'center', marginBottom:20, cursor:'pointer', backgroundColor:'white' }}>
          <input ref={inputRef} type="file" accept=".xlsx,.xls" onChange={handleFileChange} style={{ display:'none' }} />
          <div style={{ fontSize:28, marginBottom:10, color:'#7B3FAD', display:'flex', justifyContent:'center' }}><FaFileExcel size={26} /></div>
          <div style={{ fontSize:15, fontWeight:700, color:'#1a0820', marginBottom:6 }}>
            {file ? file.name : `Choose ${vendor} Excel file`}
          </div>
          <div style={{ fontSize:12, color:'#888' }}>.xlsx or .xls · Rows mapped using the {vendor} column layout</div>
        </div>
      )}

      {vendor && file && (
        <div style={{ display:'flex', justifyContent:'center', gap:10, marginBottom:24 }}>
          <button onClick={handleImport} disabled={uploading}
            style={{ padding:'13px 32px', borderRadius:14, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', fontSize:14, fontWeight:800, border:'none', cursor:uploading?'not-allowed':'pointer', opacity:uploading?0.6:1, display:'inline-flex', alignItems:'center', gap:8 }}>
            {uploading && <FaArrowRotateRight size={14} style={{ animation:'spin 0.8s linear infinite' }} />}
            {uploading ? 'Importing Shipments…' : 'Import Shipments'}
          </button>
          {result && (
            <button onClick={reset}
              style={{ padding:'13px 20px', borderRadius:14, border:'1.5px solid #e5e7eb', background:'white', color:'#374151', fontSize:14, fontWeight:700, cursor:'pointer' }}>
              Import Another File
            </button>
          )}
        </div>
      )}

      {uploading && (
        <div style={{ textAlign:'center', color:'#7B3FAD', fontSize:13, fontWeight:600, marginBottom:20 }}>
          Reading rows, creating shipments, and generating Garuda Waybills — this can take a little while for large files…
        </div>
      )}

      {error && <div style={{ backgroundColor:'#fef2f2', border:'1px solid #fca5a5', color:'#dc2626', borderRadius:12, padding:'12px 16px', marginBottom:20, fontSize:13, display:'flex', alignItems:'center', gap:8 }}><FaTriangleExclamation size={13} /> {error}</div>}

      {/* Import Summary */}
      {result && (
        <div style={{ backgroundColor:'white', borderRadius:20, border:'1px solid #f0e8f9', overflow:'hidden', marginBottom:24 }}>
          <div style={{ padding:'16px 20px', borderBottom:'1px solid #f0e8f9', display:'flex', alignItems:'center', gap:8 }}>
            <FaCheck size={14} color="#059669" />
            <div style={{ fontWeight:700, color:'#1a0820', fontSize:14 }}>Excel Import Completed — {result.vendor}</div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(120px, 1fr))', gap:1, backgroundColor:'#f0e8f9' }}>
            {[
              ['Rows Read', result.rowsRead, '#374151'],
              ['Imported', result.imported, '#059669'],
              ['Duplicates', result.duplicates, '#d97706'],
              ['Invalid', result.invalid, '#dc2626'],
              ['Pending Rows', result.pendingRows?.length || 0, '#7B3FAD'],
            ].map(([label, value, color]) => (
              <div key={label} style={{ backgroundColor:'white', padding:'16px 14px', textAlign:'center' }}>
                <div style={{ fontSize:24, fontWeight:800, color }}>{value}</div>
                <div style={{ fontSize:10, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.08em', fontWeight:700, marginTop:4 }}>{label}</div>
              </div>
            ))}
          </div>

          {result.pendingRows?.length > 0 && (
            <div style={{ padding:18 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                <div>
                  <div style={{ fontSize:12, fontWeight:700, color:'#1a0820' }}>Pending — Fill in Required Fields ({result.pendingRows.length})</div>
                  <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>These rows were missing a required field or matched an existing shipment. Fill them in below to complete the import for that row.</div>
                </div>
                <button onClick={()=>downloadSkippedRowsCsv(result.vendor, result.skippedRows)}
                  style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 12px', borderRadius:10, border:'1.5px solid #7B3FAD', color:'#7B3FAD', backgroundColor:'white', fontSize:11, fontWeight:700, cursor:'pointer', flexShrink:0 }}>
                  <FaDownload size={10} /> Download CSV
                </button>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {result.pendingRows.map(r => (
                  <PendingRowFixForm key={r.recordId} jobId={result.jobId} row={r} />
                ))}
              </div>
            </div>
          )}

          <div style={{ padding:'14px 20px', borderTop:'1px solid #f0e8f9', display:'flex', justifyContent:'flex-end' }}>
            <Link to="/shipments"
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', borderRadius:10, border:'1.5px solid #7B3FAD', color:'#7B3FAD', fontSize:12, fontWeight:700, textDecoration:'none' }}>
              View Imported Shipments
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function BulkUploadPage() {
  const { authFetch, token } = useAuth()
  const [tab, setTab] = useState('scan') // 'scan' | 'import' | 'excel'
  const inputRef = useRef()
  const [items,    setItems]    = useState([])
  const [scanning, setScanning] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [toast,    setToast]    = useState(null)

  const showToast = (msg, type='success') => { setToast({msg,type}); setTimeout(()=>setToast(null), 4000) }

  const addFiles = useCallback((incoming) => {
    const valid = Array.from(incoming).filter(f => ALLOWED.includes(f.type))
    if (!valid.length) { showToast('Please upload PDF or image files only.','error'); return }
    setItems(prev => [...prev, ...valid.map(f => ({ id:crypto.randomUUID(), file:f, result:null, saved:null, saving:false, generating:false, cardError:null }))])
  }, [])

  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }

  const scanFile = async (item) => {
    const fd = new FormData()
    fd.append('waybill', item.file)
    try {
      const res  = await authFetch('/api/shipments/upload-ocr', { method:'POST', body:fd })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'OCR failed')
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, result:data } : i))
    } catch (err) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, cardError:err.message } : i))
    }
  }

  const scanAll = async () => {
    const pending = items.filter(i => !i.result && !i.cardError)
    if (!pending.length) return
    setScanning(true)
    for (const item of pending) await scanFile(item)
    setScanning(false)
    showToast(`Scan complete — ${pending.length} file(s) processed`)
  }

  const handleSave = async (itemId, fields, filename) => {
    setItems(prev => prev.map(i => i.id===itemId ? {...i,saving:true} : i))
    try {
      const res  = await authFetch('/api/shipments', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...fields,original_waybill_file:filename}) })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setItems(prev => prev.map(i => i.id===itemId ? {...i,saved:data.data.ge_tracking_number,saving:false} : i))
      showToast(`Shipment created: ${data.data.ge_tracking_number}`)
    } catch (err) {
      setItems(prev => prev.map(i => i.id===itemId ? {...i,saving:false,cardError:'Save failed: '+err.message} : i))
      showToast('Save failed: '+err.message,'error')
    }
  }

  const handleGenerate = async (itemId, geNum) => {
    if (!window.confirm('Generate Waybill?')) return
    // Find shipment ID from GE number
    setItems(prev => prev.map(i => i.id===itemId ? {...i,generating:true} : i))
    try {
      const listRes = await authFetch(`/api/shipments?q=${geNum}&limit=1`)
      const listData = await listRes.json()
      const shipId = listData.data?.[0]?.id
      if (!shipId) throw new Error('Shipment not found')

      await downloadWaybill(authFetch, shipId, `GarudaWaybill_${geNum}.pdf`)
      showToast('Waybill downloaded!')
    } catch (err) {
      showToast('Failed: '+err.message,'error')
    } finally {
      setItems(prev => prev.map(i => i.id===itemId ? {...i,generating:false} : i))
    }
  }

  const discard = (id) => setItems(prev => prev.filter(i => i.id !== id))

  const pendingCount = items.filter(i => !i.result && !i.cardError && !i.saved).length
  const savedCount   = items.filter(i => i.saved).length
  const readyCount   = items.filter(i => i.result && !i.saved).length

  return (
    <AdminLayout>
      <style>{`@keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }`}</style>

      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top:20, right:20, zIndex:300, padding:'12px 20px', borderRadius:16, fontSize:13, fontWeight:700, boxShadow:'0 8px 24px rgba(0,0,0,0.15)', display:'flex', alignItems:'center', gap:8, backgroundColor:toast.type==='error'?'#dc2626':'#059669', color:'white', animation:'slideIn 0.3s ease' }}>
          {toast.type==='error'?<FaXmark size={13}/>:<FaCheck size={13}/>} {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16, marginBottom:20, flexWrap:'wrap' }}>
        <div>
          <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>Bulk Upload</h1>
          <p style={{ color:'#666', fontSize:14, marginTop:4 }}>Scan individual waybills, import a CSV/Excel/ZIP batch, or import vendor Excel shipments (ICL / World First)</p>
        </div>
      </div>

      {/* Tab toggle */}
      <div style={{ display:'flex', gap:8, marginBottom:24 }}>
        <button onClick={()=>setTab('scan')}
          style={{ padding:'9px 20px', borderRadius:50, border:'1.5px solid', borderColor: tab==='scan'?'#7B3FAD':'#e5e7eb', backgroundColor: tab==='scan'?'#7B3FAD':'white', color: tab==='scan'?'white':'#374151', fontSize:13, fontWeight:700, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:8 }}>
          <FaCamera size={13} /> Scan Documents
        </button>
        <button onClick={()=>setTab('import')}
          style={{ padding:'9px 20px', borderRadius:50, border:'1.5px solid', borderColor: tab==='import'?'#7B3FAD':'#e5e7eb', backgroundColor: tab==='import'?'#7B3FAD':'white', color: tab==='import'?'white':'#374151', fontSize:13, fontWeight:700, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:8 }}>
          <FaFolderOpen size={13} /> Import File (CSV/Excel/ZIP)
        </button>
        <button onClick={()=>setTab('excel')}
          style={{ padding:'9px 20px', borderRadius:50, border:'1.5px solid', borderColor: tab==='excel'?'#7B3FAD':'#e5e7eb', backgroundColor: tab==='excel'?'#7B3FAD':'white', color: tab==='excel'?'white':'#374151', fontSize:13, fontWeight:700, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:8 }}>
          <FaFileExcel size={13} /> Excel Upload (ICL / World First)
        </button>
      </div>

      {tab === 'excel' ? <VendorExcelImportTab /> : tab === 'import' ? <BulkImportTab /> : (
      <>
      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top:20, right:20, zIndex:300, padding:'12px 20px', borderRadius:16, fontSize:13, fontWeight:700, boxShadow:'0 8px 24px rgba(0,0,0,0.15)', display:'flex', alignItems:'center', gap:8, backgroundColor:toast.type==='error'?'#dc2626':'#059669', color:'white', animation:'slideIn 0.3s ease' }}>
          {toast.type==='error'?<FaXmark size={13}/>:<FaCheck size={13}/>} {toast.msg}
        </div>
      )}

      {/* Sub-header with counts */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'flex-end', gap:16, marginBottom:24, flexWrap:'wrap' }}>
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          {savedCount>0  && <span style={{ backgroundColor:'#dcfce7', color:'#166534', padding:'4px 12px', borderRadius:50, fontSize:12, fontWeight:700 }}>{savedCount} saved</span>}
          {readyCount>0  && <span style={{ backgroundColor:'#ede9fe', color:'#5b21b6', padding:'4px 12px', borderRadius:50, fontSize:12, fontWeight:700 }}>{readyCount} ready</span>}
          {pendingCount>0 && <span style={{ backgroundColor:'#f3f4f6', color:'#374151', padding:'4px 12px', borderRadius:50, fontSize:12, fontWeight:700 }}>{pendingCount} pending</span>}
          {items.length>0 && <button onClick={() => setItems([])} style={{ border:'1.5px solid #fca5a5', color:'#dc2626', backgroundColor:'white', padding:'6px 14px', borderRadius:10, fontSize:12, fontWeight:700, cursor:'pointer' }}>Clear All</button>}
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e=>{e.preventDefault();setDragOver(true)}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={handleDrop}
        onClick={()=>inputRef.current?.click()}
        style={{ border:`2px dashed ${dragOver?'#7B3FAD':'#d8b4fe'}`, borderRadius:20, padding:'48px 24px', textAlign:'center', marginBottom:24, cursor:'pointer', backgroundColor:dragOver?'#faf5ff':'white', transition:'all 0.2s', transform:dragOver?'scale(1.01)':'scale(1)' }}>
        <input ref={inputRef} type="file" multiple accept=".png,.jpg,.jpeg,.tiff,.pdf,.webp" onChange={e=>addFiles(e.target.files)} style={{ display:'none' }} />
        <div style={{ width:60, height:60, borderRadius:16, backgroundColor:'#ede9fe', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px', fontSize:28, color:'#7B3FAD' }}>
          <FaCloudArrowUp size={26} />
        </div>
        <div style={{ fontSize:16, fontWeight:700, color:'#1a0820', marginBottom:6 }}>Drag &amp; drop waybill files here</div>
        <div style={{ fontSize:13, color:'#888', marginBottom:8 }}>or click to browse — PDF, PNG, JPG, TIFF, WebP · Max 20 MB</div>
        <div style={{ fontSize:12, color:'#7B3FAD', fontWeight:600 }}>Auto-detects: FedEx · UPS · DHL · Aramex · Rotated PDFs</div>
      </div>

      {/* Scan button */}
      {pendingCount > 0 && (
        <div style={{ display:'flex', justifyContent:'center', marginBottom:24 }}>
          <button onClick={scanAll} disabled={scanning}
            style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 36px', borderRadius:16, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', fontSize:16, fontWeight:800, border:'none', cursor:scanning?'not-allowed':'pointer', opacity:scanning?0.7:1, boxShadow:'0 8px 24px rgba(123,63,173,0.3)', transition:'all 0.2s' }}>
            <span style={{ fontSize:20, display:'inline-flex', animation:scanning?'spin 0.8s linear infinite':undefined }}>
              {scanning ? <FaArrowRotateRight size={18} /> : <FaMagnifyingGlass size={18} />}
            </span>
            {scanning ? `Scanning ${pendingCount} file(s)…` : `Scan ${pendingCount} File${pendingCount>1?'s':''} & Extract Data`}
          </button>
        </div>
      )}

      {/* File cards */}
      {items.length > 0 ? (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          {items.map(item => (
            <FileCard
              key={item.id}
              item={item}
              onDiscard={() => discard(item.id)}
              onSave={(fields, filename) => handleSave(item.id, fields, filename)}
              onGenerate={(geNum) => handleGenerate(item.id, geNum)}
            />
          ))}
        </div>
      ) : (
        <div style={{ textAlign:'center', padding:'48px 0', color:'#ccc' }}>
          <div style={{ fontSize:48, marginBottom:12, display:'flex', justifyContent:'center' }}><FaInbox /></div>
          <p style={{ fontSize:14 }}>No files queued. Drop files above to start.</p>
        </div>
      )}
      </>
      )}
    </AdminLayout>
  )
}