// src/pages/CarrierManagement.jsx
import React, { useState, useEffect } from 'react'
import { FaXmark, FaTriangleExclamation, FaArrowRotateRight, FaTruck } from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import { useAuth } from '../context/AuthContext.jsx'

function CarrierModal({ carrier, onClose, onSave }) {
  const [form, setForm] = useState(carrier || { name:'', code:'', region:'International', tracking_provider:'trackingmore', priority:100 })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const handle = e => setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  const inp = { width:'100%', border:'1.5px solid #e5e7eb', borderRadius:10, padding:'9px 14px', fontSize:14, outline:'none', boxSizing:'border-box', fontFamily:'inherit' }
  const lbl = { display:'block', fontSize:10, color:'#7B3FAD', textTransform:'uppercase', letterSpacing:'0.12em', fontWeight:700, marginBottom:6 }

  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError(null)
    try { await onSave(form) } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.5)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ backgroundColor:'white', borderRadius:24, width:'100%', maxWidth:420 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'20px 24px', borderBottom:'1px solid #f0e8f9' }}>
          <h2 style={{ fontSize:17, fontWeight:800, color:'#1a0820', margin:0 }}>{carrier ? 'Edit Carrier' : 'New Carrier'}</h2>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, color:'#9ca3af', cursor:'pointer', display:'flex' }}><FaXmark size={18} /></button>
        </div>
        <form onSubmit={submit} style={{ padding:24, display:'flex', flexDirection:'column', gap:16 }}>
          {error && <div style={{ backgroundColor:'#fef2f2', border:'1px solid #fca5a5', color:'#dc2626', borderRadius:10, padding:'10px 14px', fontSize:13, display:'flex', alignItems:'center', gap:8 }}><FaTriangleExclamation size={13} /> {error}</div>}
          <div><label style={lbl}>Carrier Name</label><input name="name" value={form.name} onChange={handle} required disabled={!!carrier} style={{...inp, opacity:carrier?0.6:1}} placeholder="UPS" /></div>
          {!carrier && <div><label style={lbl}>Code</label><input name="code" value={form.code} onChange={handle} required style={inp} placeholder="UPS" /></div>}
          <div>
            <label style={lbl}>Region</label>
            <select name="region" value={form.region} onChange={handle} style={{ ...inp, backgroundColor:'white' }}>
              <option value="International">International</option>
              <option value="India">India</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Tracking Provider</label>
            <select name="tracking_provider" value={form.tracking_provider} onChange={handle} style={{ ...inp, backgroundColor:'white' }}>
              <option value="trackingmore">TrackingMore (primary)</option>
              <option value="17track">17Track (fallback)</option>
              <option value="manual">Manual only</option>
            </select>
          </div>
          {carrier && (
            <div>
              <label style={lbl}>Status</label>
              <select name="status" value={form.status} onChange={handle} style={{ ...inp, backgroundColor:'white' }}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
          )}
          <div><label style={lbl}>Priority (lower = tried first in lists)</label><input name="priority" type="number" value={form.priority} onChange={handle} style={inp} /></div>
          <div style={{ display:'flex', gap:10, paddingTop:4 }}>
            <button type="button" onClick={onClose} style={{ flex:1, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', padding:'11px 0', borderRadius:12, fontSize:14, fontWeight:700, cursor:'pointer' }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ flex:1, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', padding:'11px 0', borderRadius:12, fontSize:14, fontWeight:700, cursor:saving?'not-allowed':'pointer', opacity:saving?0.7:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
              {saving ? <><FaArrowRotateRight size={13} style={{ animation:'spin 0.8s linear infinite' }} /> Saving…</> : carrier ? 'Save Changes' : 'Create Carrier'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function CarrierManagement() {
  const { authFetch } = useAuth()
  const [carriers, setCarriers] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [tab, setTab] = useState('International')

  const load = () => {
    setLoading(true)
    authFetch('/api/carriers').then(r=>r.json()).then(d=>{ if(d.success) setCarriers(d.data) }).finally(()=>setLoading(false))
  }
  useEffect(load, [])

  const handleSave = async (form) => {
    const url = form.id ? `/api/carriers/${form.id}` : '/api/carriers'
    const method = form.id ? 'PUT' : 'POST'
    const res = await authFetch(url, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) })
    const data = await res.json()
    if (!data.success) throw new Error(data.error || 'Operation failed')
    setModal(null); load()
  }

  const handleDeactivate = async (id) => {
    if (!window.confirm('Deactivate this carrier? It will no longer be offered for new shipments.')) return
    await authFetch(`/api/carriers/${id}`, { method:'DELETE' }); load()
  }

  const filtered = carriers.filter(c => c.region === tab)

  return (
    <AdminLayout>
      {modal !== null && <CarrierModal carrier={modal?.id ? modal : null} onClose={()=>setModal(null)} onSave={handleSave} />}

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>Carrier Management</h1>
          <p style={{ color:'#766D82', fontSize:14, marginTop:4 }}>{carriers.length} carriers configured</p>
        </div>
        <button onClick={()=>setModal({})}
          style={{ display:'flex', alignItems:'center', gap:8, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', padding:'10px 20px', borderRadius:12, fontSize:13, fontWeight:700, cursor:'pointer', boxShadow:'0 4px 12px rgba(123,63,173,0.25)' }}>
          <FaTruck size={13} /> Add Carrier
        </button>
      </div>

      <div style={{ display:'flex', gap:8, marginBottom:16 }}>
        {['International','India'].map(r => (
          <button key={r} onClick={()=>setTab(r)}
            style={{ padding:'8px 18px', borderRadius:50, border:'1.5px solid', borderColor: tab===r ? '#7B3FAD' : '#e5e7eb', backgroundColor: tab===r ? '#7B3FAD' : 'white', color: tab===r ? 'white' : '#374151', fontSize:13, fontWeight:700, cursor:'pointer' }}>
            {r} ({carriers.filter(c=>c.region===r).length})
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:48, color:'#9ca3af' }}>Loading carriers…</div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:14 }}>
          {filtered.map(c => (
            <div key={c.id} style={{ backgroundColor:'white', borderRadius:16, border:'1px solid #f0e8f9', padding:18, boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
                <div>
                  <div style={{ fontWeight:700, fontSize:14, color:'#1a0820' }}>{c.name}</div>
                  <div style={{ fontSize:11, color:'#9ca3af', fontFamily:'monospace' }}>{c.code}</div>
                </div>
                <span style={{ fontSize:10, fontWeight:700, padding:'3px 10px', borderRadius:50, backgroundColor: c.status==='Active' ? 'rgba(5,150,105,0.1)' : 'rgba(107,114,128,0.1)', color: c.status==='Active' ? '#059669' : '#4b5563' }}>{c.status}</span>
              </div>
              <div style={{ fontSize:12, color:'#766D82', marginBottom:12 }}>
                Provider: <b>{c.tracking_provider}</b> · Priority {c.priority}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={()=>setModal(c)} style={{ flex:1, padding:'7px 0', borderRadius:8, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', fontSize:12, fontWeight:700, cursor:'pointer' }}>Edit</button>
                {c.status === 'Active' && (
                  <button onClick={()=>handleDeactivate(c.id)} style={{ flex:1, padding:'7px 0', borderRadius:8, border:'1.5px solid #fca5a5', backgroundColor:'white', color:'#dc2626', fontSize:12, fontWeight:700, cursor:'pointer' }}>Deactivate</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </AdminLayout>
  )
}
