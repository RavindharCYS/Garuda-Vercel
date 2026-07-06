// src/pages/ChangePassword.jsx
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FaCheck } from 'react-icons/fa6'
import { useAuth } from '../context/AuthContext.jsx'

export default function ChangePassword({ forced = false }) {
  const { authFetch, user, clearMustChangePassword } = useAuth()
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (newPassword !== confirm) { setError('New passwords do not match'); return }
    if (newPassword.length < 10) { setError('Password must be at least 10 characters'); return }
    setLoading(true)
    try {
      const res = await authFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setSuccess(true)
      clearMustChangePassword()
      setTimeout(() => navigate(user?.role === 'admin' ? '/admin/dashboard' : '/shipments'), 1200)
    } catch (err) { setError(err.message || 'Failed to update password') }
    finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(160deg,#1a0820 0%,#2d1040 50%,#3d1f5c 100%)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ width:'100%', maxWidth:420 }}>
        <div style={{ backgroundColor:'rgba(255,255,255,0.05)', backdropFilter:'blur(24px)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:24, padding:32 }}>
          <h2 style={{ color:'white', fontWeight:700, fontSize:22, marginBottom:4 }}>
            {forced ? 'Password Change Required' : 'Change Password'}
          </h2>
          <p style={{ color:'rgba(255,255,255,0.4)', fontSize:14, marginBottom:24 }}>
            {forced ? 'For security, you must set a new password before continuing.' : 'Update your account password.'}
          </p>

          {error && (
            <div style={{ backgroundColor:'rgba(239,68,68,0.12)', border:'1px solid rgba(239,68,68,0.4)', borderRadius:12, padding:'12px 16px', marginBottom:20 }}>
              <span style={{ color:'#f87171', fontSize:13, fontWeight:600 }}>{error}</span>
            </div>
          )}
          {success && (
            <div style={{ backgroundColor:'rgba(5,150,105,0.12)', border:'1px solid rgba(5,150,105,0.4)', borderRadius:12, padding:'12px 16px', marginBottom:20 }}>
              <span style={{ color:'#34d399', fontSize:13, fontWeight:600, display:'inline-flex', alignItems:'center', gap:6 }}><FaCheck size={11} /> Password updated! Redirecting…</span>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {[
              { label:'Current Password', value:currentPassword, set:setCurrentPassword },
              { label:'New Password', value:newPassword, set:setNewPassword },
              { label:'Confirm New Password', value:confirm, set:setConfirm },
            ].map((f, i) => (
              <div key={i}>
                <label style={{ display:'block', color:'rgba(255,255,255,0.5)', fontSize:10, textTransform:'uppercase', letterSpacing:'0.15em', fontWeight:700, marginBottom:8 }}>{f.label}</label>
                <input type="password" value={f.value} onChange={e=>f.set(e.target.value)} required
                  style={{ width:'100%', backgroundColor:'rgba(255,255,255,0.08)', border:'1.5px solid rgba(255,255,255,0.1)', borderRadius:14, padding:'14px', color:'white', fontSize:14, outline:'none', boxSizing:'border-box' }} />
              </div>
            ))}
            <p style={{ color:'rgba(255,255,255,0.35)', fontSize:11, margin:0 }}>
              Minimum 10 characters, with uppercase, lowercase, a number, and a symbol.
            </p>
            <button type="submit" disabled={loading}
              style={{ marginTop:8, padding:'15px 0', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:loading?'not-allowed':'pointer', opacity:loading?0.7:1 }}>
              {loading ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
