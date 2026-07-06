// src/pages/AdminLogin.jsx
import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { FaTriangleExclamation, FaUser, FaLock, FaEyeSlash, FaEye, FaArrowRotateRight, FaArrowRight, FaArrowLeft } from 'react-icons/fa6'
import { useAuth } from '../context/AuthContext.jsx'

export default function AdminLogin() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const { login, user, mustChangePassword } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (user) navigate(mustChangePassword ? '/change-password' : (user.role === 'admin' ? '/admin/dashboard' : '/shipments'))
  }, [user])

  const handleSubmit = async (e) => {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const u = await login(username, password)
      if (u.mustChangePassword) navigate('/change-password')
      else navigate(u.role === 'admin' ? '/admin/dashboard' : '/shipments')
    } catch (err) { setError(err.message || 'Invalid credentials') }
    finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(160deg,#1a0820 0%,#2d1040 50%,#3d1f5c 100%)', display:'flex', alignItems:'center', justifyContent:'center', padding:20, position:'relative', overflow:'hidden' }}>
      {/* Background orbs */}
      <div style={{ position:'absolute', top:-150, right:-150, width:400, height:400, borderRadius:'50%', background:'radial-gradient(circle,rgba(123,63,173,0.2),transparent 70%)', pointerEvents:'none' }} />
      <div style={{ position:'absolute', bottom:-100, left:-100, width:300, height:300, borderRadius:'50%', background:'radial-gradient(circle,rgba(91,45,139,0.15),transparent 70%)', pointerEvents:'none' }} />

      <div style={{ width:'100%', maxWidth:420, position:'relative', zIndex:1 }}>
        {/* Logo */}
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <a href="/" style={{ display:'inline-flex', flexDirection:'column', alignItems:'center', gap:10, textDecoration:'none' }}>
            <img src="/assets/logo.png" alt="Garuda Express"
              style={{ width:64, height:64, borderRadius:'50%', objectFit:'cover', boxShadow:'0 8px 24px rgba(123,63,173,0.4)' }} />
            <div>
              <div style={{ color:'white', fontWeight:700, fontSize:22, letterSpacing:'-0.02em' }}>Garuda Express</div>
              <div style={{ color:'rgba(255,255,255,0.4)', fontSize:10, textTransform:'uppercase', letterSpacing:'0.2em', marginTop:2 }}>Internal Portal</div>
            </div>
          </a>
        </div>

        {/* Card */}
        <div style={{ backgroundColor:'rgba(255,255,255,0.05)', backdropFilter:'blur(24px)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:24, padding:32 }}>
          <h2 style={{ color:'white', fontWeight:700, fontSize:22, marginBottom:4 }}>Sign In</h2>
          <p style={{ color:'rgba(255,255,255,0.4)', fontSize:14, marginBottom:24 }}>Access your dashboard</p>

          {error && (
            <div style={{ backgroundColor:'rgba(239,68,68,0.12)', border:'1px solid rgba(239,68,68,0.4)', borderRadius:12, padding:'12px 16px', marginBottom:20, display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ color:'#f87171', fontSize:18, flexShrink:0, display:'flex' }}><FaTriangleExclamation size={16} /></span>
              <span style={{ color:'#f87171', fontSize:13, fontWeight:600 }}>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div>
              <label style={{ display:'block', color:'rgba(255,255,255,0.5)', fontSize:10, textTransform:'uppercase', letterSpacing:'0.15em', fontWeight:700, marginBottom:8 }}>Username</label>
              <div style={{ position:'relative' }}>
                <span style={{ position:'absolute', left:16, top:'50%', transform:'translateY(-50%)', fontSize:16, opacity:0.4, display:'flex' }}><FaUser size={15} /></span>
                <input type="text" value={username} onChange={e=>setUsername(e.target.value)} required autoFocus
                  placeholder="Enter username"
                  style={{ width:'100%', backgroundColor:'rgba(255,255,255,0.08)', border:'1.5px solid rgba(255,255,255,0.1)', borderRadius:14, padding:'14px 14px 14px 44px', color:'white', fontSize:14, outline:'none', boxSizing:'border-box', transition:'border-color 0.2s' }}
                  onFocus={e=>e.target.style.borderColor='rgba(123,63,173,0.7)'}
                  onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
              </div>
            </div>

            <div>
              <label style={{ display:'block', color:'rgba(255,255,255,0.5)', fontSize:10, textTransform:'uppercase', letterSpacing:'0.15em', fontWeight:700, marginBottom:8 }}>Password</label>
              <div style={{ position:'relative' }}>
                <span style={{ position:'absolute', left:16, top:'50%', transform:'translateY(-50%)', fontSize:16, opacity:0.4, display:'flex' }}><FaLock size={15} /></span>
                <input type={showPass?'text':'password'} value={password} onChange={e=>setPassword(e.target.value)} required
                  placeholder="Enter password"
                  style={{ width:'100%', backgroundColor:'rgba(255,255,255,0.08)', border:'1.5px solid rgba(255,255,255,0.1)', borderRadius:14, padding:'14px 48px 14px 44px', color:'white', fontSize:14, outline:'none', boxSizing:'border-box', transition:'border-color 0.2s' }}
                  onFocus={e=>e.target.style.borderColor='rgba(123,63,173,0.7)'}
                  onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
                <button type="button" onClick={()=>setShowPass(s=>!s)}
                  style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:'rgba(255,255,255,0.35)', cursor:'pointer', fontSize:16, padding:4, lineHeight:1, display:'flex', alignItems:'center' }}>
                  {showPass ? <FaEyeSlash size={15} /> : <FaEye size={15} />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading}
              style={{ marginTop:8, padding:'15px 0', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', borderRadius:14, fontSize:15, fontWeight:800, cursor:loading?'not-allowed':'pointer', opacity:loading?0.7:1, display:'flex', alignItems:'center', justifyContent:'center', gap:10, boxShadow:'0 8px 24px rgba(123,63,173,0.4)', transition:'all 0.2s' }}>
              {loading ? (
                <><span style={{ display:'inline-flex', animation:'spin 0.8s linear infinite' }}><FaArrowRotateRight size={14} /></span> Signing in…</>
              ) : (
                <><FaArrowRight size={14} /> Sign In</>
              )}
            </button>
          </form>

          <div style={{ marginTop:24, paddingTop:20, borderTop:'1px solid rgba(255,255,255,0.08)', textAlign:'center' }}>
            <a href="/" style={{ color:'rgba(255,255,255,0.35)', fontSize:13, textDecoration:'none', display:'inline-flex', alignItems:'center', gap:6, transition:'color 0.2s' }}
              onMouseEnter={e=>e.target.style.color='rgba(255,255,255,0.7)'}
              onMouseLeave={e=>e.target.style.color='rgba(255,255,255,0.35)'}>
              <FaArrowLeft size={11} /> Back to Public Site
            </a>
          </div>
        </div>
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}} input::placeholder{color:rgba(255,255,255,0.2)!important}`}</style>
    </div>
  )
}
