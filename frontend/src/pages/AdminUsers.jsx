// src/pages/AdminUsers.jsx
import React, { useState, useEffect } from 'react'
import {
  FaXmark, FaTriangleExclamation, FaArrowRotateRight, FaKey, FaClipboard,
  FaUser, FaPen, FaRotate, FaLockOpen, FaBan,
} from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import ConfirmModal from '../components/ConfirmModal.jsx'
import { useAuth } from '../context/AuthContext.jsx'

function UserModal({ user, onClose, onSave }) {
  const [form, setForm] = useState(user || { username:'', password:'', role:'employee', name:'', employeeId:'', email:'', phone:'', branch:'' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  const handle = e => setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  const inp = { width:'100%', border:'1.5px solid #e5e7eb', borderRadius:10, padding:'9px 14px', fontSize:14, outline:'none', boxSizing:'border-box', fontFamily:'inherit' }
  const lbl = { display:'block', fontSize:10, color:'#7B3FAD', textTransform:'uppercase', letterSpacing:'0.12em', fontWeight:700, marginBottom:6 }

  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError(null)
    try { await onSave(form) } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.5)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:20, overflowY:'auto' }}>
      <div style={{ backgroundColor:'white', borderRadius:24, width:'100%', maxWidth:460, boxShadow:'0 24px 64px rgba(0,0,0,0.15)', animation:'slideUp 0.2s ease', maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'20px 24px', borderBottom:'1px solid #f0e8f9' }}>
          <h2 style={{ fontSize:17, fontWeight:800, color:'#1a0820', margin:0 }}>{user ? 'Edit User' : 'New User'}</h2>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, color:'#9ca3af', cursor:'pointer', lineHeight:1, padding:4, display:'flex' }}><FaXmark size={18} /></button>
        </div>
        <form onSubmit={submit} style={{ padding:24, display:'flex', flexDirection:'column', gap:16 }}>
          {error && <div style={{ backgroundColor:'#fef2f2', border:'1px solid #fca5a5', color:'#dc2626', borderRadius:10, padding:'10px 14px', fontSize:13, display:'flex', alignItems:'center', gap:8 }}><FaTriangleExclamation size={13} /> {error}</div>}
          <div><label style={lbl}>Full Name</label><input name="name" value={form.name||''} onChange={handle} required style={inp} placeholder="John Smith" /></div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div><label style={lbl}>Username</label><input name="username" value={form.username||''} onChange={handle} required disabled={!!user} style={{ ...inp, opacity:user?0.6:1 }} placeholder="johnsmith" /></div>
            <div><label style={lbl}>Employee ID</label><input name="employeeId" value={form.employeeId||form.employee_id||''} onChange={handle} style={inp} placeholder="EMP-0003" /></div>
          </div>
          {!user && (
            <div><label style={lbl}>Password</label><input name="password" value={form.password||''} onChange={handle} required type="password" style={inp} placeholder="••••••••" /></div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div><label style={lbl}>Email</label><input name="email" type="email" value={form.email||''} onChange={handle} style={inp} placeholder="john@company.com" /></div>
            <div><label style={lbl}>Phone</label><input name="phone" value={form.phone||''} onChange={handle} style={inp} placeholder="+91 98765 43210" /></div>
          </div>
          <div><label style={lbl}>Branch</label><input name="branch" value={form.branch||''} onChange={handle} style={inp} placeholder="Chennai HQ" /></div>
          <div>
            <label style={lbl}>Role</label>
            <select name="role" value={form.role} onChange={handle} style={{ ...inp, backgroundColor:'white' }}>
              <option value="employee">Employee</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {user && (
            <div>
              <label style={lbl}>Status</label>
              <select name="status" value={form.status||'Active'} onChange={handle} style={{ ...inp, backgroundColor:'white' }}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
          )}
          <div style={{ display:'flex', gap:10, paddingTop:4 }}>
            <button type="button" onClick={onClose} style={{ flex:1, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', padding:'11px 0', borderRadius:12, fontSize:14, fontWeight:700, cursor:'pointer' }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ flex:1, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', padding:'11px 0', borderRadius:12, fontSize:14, fontWeight:700, cursor:saving?'not-allowed':'pointer', opacity:saving?0.7:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
              {saving ? <><FaArrowRotateRight size={13} style={{ animation:'spin 0.8s linear infinite' }} /> Saving…</> : user ? 'Save Changes' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
      <style>{`@keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  )
}

function TempPasswordModal({ tempPassword, username, onClose }) {
  return (
    <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.5)', zIndex:110, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ backgroundColor:'white', borderRadius:24, width:'100%', maxWidth:420, padding:28, textAlign:'center' }}>
        <div style={{ fontSize:36, marginBottom:8, color:'#7B3FAD', display:'flex', justifyContent:'center' }}><FaKey size={32} /></div>
        <h2 style={{ fontSize:18, fontWeight:800, color:'#1a0820', margin:'0 0 6px' }}>Temporary Password Generated</h2>
        <p style={{ color:'#766D82', fontSize:13, marginBottom:18 }}>For <b>@{username}</b> — share this securely. It will not be shown again.</p>
        <div style={{ backgroundColor:'#faf5ff', border:'1.5px dashed #7B3FAD', borderRadius:14, padding:'16px', fontFamily:'monospace', fontSize:18, fontWeight:800, color:'#1a0820', marginBottom:18, wordBreak:'break-all' }}>
          {tempPassword}
        </div>
        <button onClick={()=>{ navigator.clipboard?.writeText(tempPassword); }}
          style={{ width:'100%', marginBottom:10, padding:'11px 0', border:'1.5px solid #7B3FAD', backgroundColor:'white', color:'#7B3FAD', borderRadius:12, fontSize:13, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          <FaClipboard size={13} /> Copy to Clipboard
        </button>
        <button onClick={onClose} style={{ width:'100%', padding:'11px 0', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', borderRadius:12, fontSize:13, fontWeight:700, cursor:'pointer' }}>
          Done
        </button>
      </div>
    </div>
  )
}

export default function AdminUsers() {
  const { authFetch } = useAuth()
  const [users,   setUsers]   = useState([])
  const [loading, setLoading] = useState(true)
  const [modal,   setModal]   = useState(null)
  const [tempPw,  setTempPw]  = useState(null)
  const [busyId,  setBusyId]  = useState(null)
  const [confirmState, setConfirmState] = useState(null) // { title, message, danger, onConfirm }

  const load = () => {
    setLoading(true)
    authFetch('/api/admin/users').then(r=>r.json()).then(d=>{ if(d.success) setUsers(d.data) }).finally(()=>setLoading(false))
  }
  useEffect(load, [])

  const handleSave = async (form) => {
    const url    = form.id ? `/api/admin/users/${form.id}` : '/api/admin/users'
    const method = form.id ? 'PUT' : 'POST'
    const res    = await authFetch(url, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) })
    const data   = await res.json()
    if (!data.success) throw new Error(data.error || 'Operation failed')
    setModal(null); load()
  }

  const handleDeactivate = (id) => {
    setConfirmState({
      title: 'Deactivate this user?',
      message: 'They will no longer be able to log in until reactivated.',
      danger: true,
      onConfirm: async () => {
        setConfirmState(null)
        await authFetch(`/api/admin/users/${id}`, { method:'DELETE' }); load()
      },
    })
  }

  const handleResetPassword = (u) => {
    setConfirmState({
      title: 'Generate a temporary password?',
      message: `@${u.username} will be required to change it on next login.`,
      onConfirm: async () => {
        setConfirmState(null)
        setBusyId(u.id)
        try {
          const res = await authFetch(`/api/admin/users/${u.id}/reset-password`, { method:'POST' })
          const data = await res.json()
          if (data.success) setTempPw({ password: data.tempPassword, username: u.username })
        } finally { setBusyId(null); load() }
      },
    })
  }

  const handleUnlock = async (u) => {
    setBusyId(u.id)
    try { await authFetch(`/api/admin/users/${u.id}/unlock`, { method:'POST' }) }
    finally { setBusyId(null); load() }
  }

  const handleForceReset = (u) => {
    setConfirmState({
      title: 'Force a password change?',
      message: `@${u.username} will be required to change their password on next login.`,
      onConfirm: async () => {
        setConfirmState(null)
        setBusyId(u.id)
        try { await authFetch(`/api/admin/users/${u.id}/force-reset`, { method:'POST' }) }
        finally { setBusyId(null); load() }
      },
    })
  }

  const iconBtnStyle = (bg, color) => ({ width:30, height:30, borderRadius:8, border:'none', backgroundColor:bg, color, cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center' })

  return (
    <AdminLayout>
      {modal !== null && <UserModal user={modal?.id ? modal : null} onClose={()=>setModal(null)} onSave={handleSave} />}
      {tempPw && <TempPasswordModal tempPassword={tempPw.password} username={tempPw.username} onClose={()=>setTempPw(null)} />}

      <ConfirmModal
        open={!!confirmState}
        title={confirmState?.title}
        message={confirmState?.message}
        danger={confirmState?.danger}
        onConfirm={confirmState?.onConfirm}
        onCancel={() => setConfirmState(null)}
      />

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>Users</h1>
          <p style={{ color:'#766D82', fontSize:14, marginTop:4 }}>{users.length} team members</p>
        </div>
        <button onClick={()=>setModal({})}
          style={{ display:'flex', alignItems:'center', gap:8, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', padding:'10px 20px', borderRadius:12, fontSize:13, fontWeight:700, cursor:'pointer', boxShadow:'0 4px 12px rgba(123,63,173,0.25)' }}>
          <FaUser size={13} /> Add User
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:48, color:'#9ca3af' }}>Loading users…</div>
      ) : (
        <div style={{ backgroundColor:'white', borderRadius:20, border:'1px solid #f0e8f9', boxShadow:'0 1px 4px rgba(0,0,0,0.04)', overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ borderBottom:'1px solid #f0e8f9', backgroundColor:'#faf5ff' }}>
                {['Name','Username','Role','Status','Last Login','Actions'].map(h => (
                  <th key={h} style={{ padding:'12px 16px', textAlign:'left', fontWeight:700, color:'#7B3FAD', fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u,i) => (
                <tr key={u.id} style={{ borderBottom:'1px solid #faf5ff', backgroundColor:i%2===0?'white':'#fdf8ff' }}>
                  <td style={{ padding:'14px 16px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <div style={{ width:34, height:34, borderRadius:'50%', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontSize:13, fontWeight:800, flexShrink:0 }}>
                        {u.name?.[0]?.toUpperCase() || '?'}
                      </div>
                      <div>
                        <div style={{ fontWeight:600, color:'#1a0820' }}>{u.name}</div>
                        {u.employee_id && <div style={{ fontSize:10, color:'#9ca3af' }}>{u.employee_id}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding:'14px 16px', color:'#766D82', fontFamily:'monospace', fontSize:12 }}>@{u.username}</td>
                  <td style={{ padding:'14px 16px' }}>
                    <span style={{ backgroundColor:u.role==='admin'?'rgba(123,63,173,0.1)':'rgba(59,130,246,0.1)', color:u.role==='admin'?'#7B3FAD':'#2563eb', padding:'3px 10px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em' }}>
                      {u.role}
                    </span>
                  </td>
                  <td style={{ padding:'14px 16px' }}>
                    <span style={{
                      backgroundColor: u.status==='Locked' ? 'rgba(220,38,38,0.1)' : u.status==='Inactive' ? 'rgba(107,114,128,0.1)' : 'rgba(5,150,105,0.1)',
                      color: u.status==='Locked' ? '#dc2626' : u.status==='Inactive' ? '#4b5563' : '#059669',
                      padding:'3px 10px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase' }}>
                      {u.status || (u.is_active ? 'Active' : 'Inactive')}
                    </span>
                    {!!u.must_change_password && <div style={{ fontSize:9, color:'#d97706', marginTop:4, fontWeight:700, display:'flex', alignItems:'center', gap:3 }}><FaTriangleExclamation size={8} /> Must change PW</div>}
                  </td>
                  <td style={{ padding:'14px 16px', color:'#9ca3af', fontSize:12, whiteSpace:'nowrap' }}>{u.last_login_at ? u.last_login_at.slice(0,16).replace('T',' ') : 'Never'}</td>
                  <td style={{ padding:'14px 16px' }}>
                    <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                      <button onClick={()=>setModal(u)} title="Edit" style={iconBtnStyle('rgba(59,130,246,0.1)','#2563eb')}><FaPen size={12} /></button>
                      <button onClick={()=>handleResetPassword(u)} title="Reset Password" disabled={busyId===u.id} style={iconBtnStyle('rgba(217,119,6,0.1)','#d97706')}><FaKey size={12} /></button>
                      <button onClick={()=>handleForceReset(u)} title="Force change on next login" disabled={busyId===u.id} style={iconBtnStyle('rgba(124,58,237,0.1)','#7c3aed')}><FaRotate size={12} /></button>
                      {u.status === 'Locked' && (
                        <button onClick={()=>handleUnlock(u)} title="Unlock" disabled={busyId===u.id} style={iconBtnStyle('rgba(5,150,105,0.1)','#059669')}><FaLockOpen size={13} /></button>
                      )}
                      <button onClick={()=>handleDeactivate(u.id)} title="Deactivate" style={iconBtnStyle('rgba(239,68,68,0.1)','#dc2626')}><FaBan size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </AdminLayout>
  )
}