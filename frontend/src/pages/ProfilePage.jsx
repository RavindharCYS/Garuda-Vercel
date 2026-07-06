// src/pages/ProfilePage.jsx
import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { FaCheck, FaLock, FaArrowRight } from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import { useAuth } from '../context/AuthContext.jsx'

export default function ProfilePage() {
  const { authFetch, user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [history, setHistory] = useState([])
  const [form, setForm] = useState({ name:'', email:'', phone:'' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      authFetch('/api/profile').then(r=>r.json()),
      authFetch('/api/profile/login-history').then(r=>r.json()),
    ]).then(([p, h]) => {
      if (p.success) { setProfile(p.data); setForm({ name:p.data.name||'', email:p.data.email||'', phone:p.data.phone||'' }) }
      if (h.success) setHistory(h.data)
    }).finally(() => setLoading(false))
  }, [])

  const save = async (e) => {
    e.preventDefault(); setSaving(true); setSaved(false)
    try {
      const res = await authFetch('/api/profile', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) })
      const data = await res.json()
      if (data.success) { setSaved(true); setTimeout(()=>setSaved(false), 2000) }
    } finally { setSaving(false) }
  }

  const inp = { width:'100%', border:'1.5px solid #e5e7eb', borderRadius:10, padding:'10px 14px', fontSize:14, outline:'none', boxSizing:'border-box' }
  const lbl = { display:'block', fontSize:10, color:'#7B3FAD', textTransform:'uppercase', letterSpacing:'0.12em', fontWeight:700, marginBottom:6 }

  if (loading) return <AdminLayout><div style={{ textAlign:'center', padding:48, color:'#9ca3af' }}>Loading profile…</div></AdminLayout>

  return (
    <AdminLayout>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>My Profile</h1>
        <p style={{ color:'#766D82', fontSize:14, marginTop:4 }}>@{profile?.username} · {profile?.employee_id || 'No employee ID set'}</p>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }} className="profile-grid">
        <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9' }}>
          <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>Contact Information</h2>
          <form onSubmit={save}>
            <div style={{ marginBottom:16 }}><label style={lbl}>Full Name</label><input style={inp} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} /></div>
            <div style={{ marginBottom:16 }}><label style={lbl}>Email</label><input type="email" style={inp} value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} /></div>
            <div style={{ marginBottom:20 }}><label style={lbl}>Phone</label><input style={inp} value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} /></div>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <button type="submit" disabled={saving} style={{ padding:'11px 24px', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', borderRadius:12, fontSize:13, fontWeight:700, cursor:saving?'not-allowed':'pointer' }}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              {saved && <span style={{ color:'#059669', fontSize:13, fontWeight:700, display:'inline-flex', alignItems:'center', gap:6 }}><FaCheck size={11} /> Saved</span>}
            </div>
          </form>
          <div style={{ marginTop:24, paddingTop:20, borderTop:'1px solid #f0e8f9' }}>
            <Link to="/change-password" style={{ fontSize:13, fontWeight:700, color:'#7B3FAD', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:6 }}><FaLock size={11} /> Change Password <FaArrowRight size={11} /></Link>
          </div>
        </div>

        <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9' }}>
          <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16 }}>Recent Login Activity</h2>
          {!history.length ? (
            <div style={{ color:'#9ca3af', fontSize:13 }}>No login history yet.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10, maxHeight:320, overflowY:'auto' }}>
              {history.map((h,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:12, padding:'8px 0', borderBottom:'1px solid #faf5ff' }}>
                  <div>
                    <div style={{ fontWeight:600, color: h.status==='failure' ? '#dc2626' : '#1a0820' }}>{h.action.replace('_',' ')}</div>
                    <div style={{ color:'#9ca3af', fontSize:11 }}>{h.ip_address || '—'}</div>
                  </div>
                  <span style={{ color:'#9ca3af', fontSize:11 }}>{new Date(h.created_at + 'Z').toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <style>{`.profile-grid{grid-template-columns:1fr!important} @media(min-width:900px){.profile-grid{grid-template-columns:1fr 1fr!important}}`}</style>
    </AdminLayout>
  )
}
