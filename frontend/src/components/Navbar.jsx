// src/components/Navbar.jsx — Permanently dark, scroll-safe
import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { FaXmark, FaPhone, FaWhatsapp } from 'react-icons/fa6'

const EMPLOYEE_LOGIN_URL = import.meta.env.VITE_EMPLOYEE_LOGIN_URL || 'https://app.garudaexpresscourier.com'

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [logoReady,  setLogoReady]  = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setLogoReady(true), 300)
    return () => clearTimeout(t)
  }, [])

  const navLinks = [
    { label:'Track',    href:'/#track' },
    { label:'Services', href:'/#services' },
    { label:'About',    href:'/#about' },
    { label:'Partners', href:'/#partners' },
    { label:'Location', href:'/#location' },
  ]

  return (
    <>
      {/* Top bar — always dark */}
      <div style={{ backgroundColor:'#1a0820', borderBottom:'1px solid rgba(255,255,255,0.06)' }} className="hidden md:block">
        <div className="max-w-7xl mx-auto px-8 py-2 flex justify-center items-center gap-6">
          <span style={{ color:'rgba(255,255,255,0.45)', fontSize:'10px', letterSpacing:'0.15em', textTransform:'uppercase' }}>
            Best Courier Services Worldwide
          </span>
          <span style={{ width:4, height:4, borderRadius:'50%', backgroundColor:'rgba(255,255,255,0.2)', display:'inline-block' }} />
          <a href="tel:+918122257307" style={{ color:'rgba(255,255,255,0.45)', fontSize:'10px', letterSpacing:'0.12em', textTransform:'uppercase', textDecoration:'none' }}
             onMouseEnter={e=>e.target.style.color='white'} onMouseLeave={e=>e.target.style.color='rgba(255,255,255,0.45)'}>
            +91 81222 57307
          </a>
          <span style={{ width:4, height:4, borderRadius:'50%', backgroundColor:'rgba(255,255,255,0.2)', display:'inline-block' }} />
          <a href="tel:+919566122447" style={{ color:'rgba(255,255,255,0.45)', fontSize:'10px', letterSpacing:'0.12em', textTransform:'uppercase', textDecoration:'none' }}
             onMouseEnter={e=>e.target.style.color='white'} onMouseLeave={e=>e.target.style.color='rgba(255,255,255,0.45)'}>
            +91 95661 22447
          </a>
          <span style={{ width:4, height:4, borderRadius:'50%', backgroundColor:'rgba(255,255,255,0.2)', display:'inline-block' }} />
          <a href="mailto:info@garudaexpresscourier.com" style={{ color:'rgba(255,255,255,0.45)', fontSize:'10px', letterSpacing:'0.12em', textTransform:'uppercase', textDecoration:'none' }}
             onMouseEnter={e=>e.target.style.color='white'} onMouseLeave={e=>e.target.style.color='rgba(255,255,255,0.45)'}>
            info@garudaexpresscourier.com
          </a>
        </div>
      </div>

      {/* Main nav — inline style ensures dark bg always, no Tailwind class interference */}
      <header style={{ position:'sticky', top:0, zIndex:50, backgroundColor:'#1a0820', borderBottom:'1px solid rgba(255,255,255,0.08)', boxShadow:'0 4px 24px rgba(0,0,0,0.3)' }}>
        <div className="max-w-7xl mx-auto px-5 md:px-8">
          <nav style={{ display:'flex', alignItems:'center', justifyContent:'space-between', height:70 }}>

            {/* Logo */}
            <a href="/" style={{ display:'flex', alignItems:'center', gap:12, textDecoration:'none', flexShrink:0 }}>
              <div style={{ width:42, height:42, flexShrink:0, position:'relative' }}>
                <img src="/assets/logo.png" alt="Garuda Express"
                  style={{ width:'100%', height:'100%', borderRadius:'50%', objectFit:'cover',
                    opacity: logoReady ? 1 : 0,
                    transform: logoReady ? 'translate(0,0) rotate(0deg) scale(1)' : 'translate(-40px,-20px) rotate(-15deg) scale(0.6)',
                    transition: 'all 1s cubic-bezier(0.22,1,0.36,1)'
                  }} />
              </div>
              <div>
                <div style={{ color:'white', fontWeight:700, fontSize:20, lineHeight:1, letterSpacing:'-0.02em' }}>Garuda Express</div>
                <div style={{ color:'#7B3FAD', fontSize:9, textTransform:'uppercase', letterSpacing:'0.22em', marginTop:3 }}>International</div>
              </div>
            </a>

            {/* Desktop nav links */}
            <div style={{ alignItems:'center', gap:36 }} className="hidden md:flex">
              {navLinks.map(l => (
                <a key={l.label} href={l.href}
                  style={{ color:'rgba(255,255,255,0.75)', fontSize:14, fontWeight:500, textDecoration:'none', transition:'color 0.2s' }}
                  onMouseEnter={e=>e.target.style.color='white'}
                  onMouseLeave={e=>e.target.style.color='rgba(255,255,255,0.75)'}>
                  {l.label}
                </a>
              ))}
            </div>

            {/* Right buttons */}
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <a href={EMPLOYEE_LOGIN_URL} target="_blank" rel="noreferrer"
                style={{ alignItems:'center', gap:6, border:'1.5px solid rgba(123,63,173,0.5)', color:'#DFC4F2', padding:'8px 16px', borderRadius:50, fontSize:12, fontWeight:700, textDecoration:'none', transition:'all 0.2s', cursor:'pointer' }}
                className="hidden md:flex"
                onMouseEnter={e=>{e.currentTarget.style.backgroundColor='rgba(123,63,173,0.15)'}}
                onMouseLeave={e=>{e.currentTarget.style.backgroundColor='transparent'}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                Employee Login
              </a>

              <Link to="/admin"
                style={{ alignItems:'center', gap:6, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', padding:'9px 18px', borderRadius:50, fontSize:12, fontWeight:700, textDecoration:'none', boxShadow:'0 4px 14px rgba(123,63,173,0.3)', transition:'all 0.2s' }}
                className="hidden md:inline-flex"
                onMouseEnter={e=>{ e.currentTarget.style.transform='scale(1.05)'; e.currentTarget.style.boxShadow='0 6px 20px rgba(123,63,173,0.45)' }}
                onMouseLeave={e=>{ e.currentTarget.style.transform='scale(1)'; e.currentTarget.style.boxShadow='0 4px 14px rgba(123,63,173,0.3)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Admin
              </Link>

              {/* Hamburger */}
              <button onClick={() => setMobileOpen(o => !o)}
                style={{ flexDirection:'column', justifyContent:'center', alignItems:'center', gap:5, width:40, height:40, borderRadius:10, backgroundColor:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)', cursor:'pointer', padding:0 }}
                className="flex md:hidden">
                {[0,1,2].map(i => (
                  <span key={i} style={{
                    display:'block', width:20, height:2, backgroundColor:'white', borderRadius:2,
                    transition:'all 0.3s',
                    transform: mobileOpen ? (i===0 ? 'translateY(7px) rotate(45deg)' : i===2 ? 'translateY(-7px) rotate(-45deg)' : 'scaleX(0)') : 'none',
                    opacity: mobileOpen && i===1 ? 0 : 1
                  }} />
                ))}
              </button>
            </div>
          </nav>
        </div>
      </header>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.6)', zIndex:40 }}
             className="md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Mobile drawer */}
      <div style={{
        position:'fixed', top:0, right:0, bottom:0, width:'72vw', maxWidth:300,
        backgroundColor:'#1a0820', zIndex:50, borderLeft:'1px solid rgba(255,255,255,0.08)',
        flexDirection:'column',
        transform: mobileOpen ? 'translateX(0)' : 'translateX(100%)',
        transition:'transform 0.3s ease'
      }} className="flex md:hidden">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 20px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <img src="/assets/logo.png" alt="" style={{ width:28, height:28, borderRadius:'50%', objectFit:'cover' }} />
            <span style={{ color:'white', fontSize:14, fontWeight:700 }}>Garuda Express</span>
          </div>
          <button onClick={() => setMobileOpen(false)} style={{ width:32, height:32, borderRadius:8, backgroundColor:'rgba(255,255,255,0.06)', border:'none', color:'rgba(255,255,255,0.6)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <FaXmark size={14} />
          </button>
        </div>

        <nav style={{ flex:1, padding:'16px 12px', overflowY:'auto' }}>
          {navLinks.map(l => (
            <a key={l.label} href={l.href} onClick={() => setMobileOpen(false)}
              style={{ display:'flex', alignItems:'center', padding:'12px 16px', borderRadius:12, color:'rgba(255,255,255,0.7)', fontSize:14, fontWeight:500, textDecoration:'none', marginBottom:2, transition:'all 0.15s' }}
              onMouseEnter={e=>{e.currentTarget.style.backgroundColor='rgba(255,255,255,0.06)'; e.currentTarget.style.color='white'}}
              onMouseLeave={e=>{e.currentTarget.style.backgroundColor='transparent'; e.currentTarget.style.color='rgba(255,255,255,0.7)'}}>
              {l.label}
            </a>
          ))}
          <div style={{ borderTop:'1px solid rgba(255,255,255,0.08)', marginTop:8, paddingTop:8 }}>
            <a href={EMPLOYEE_LOGIN_URL} target="_blank" rel="noreferrer" onClick={() => setMobileOpen(false)}
              style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 16px', borderRadius:12, color:'#DFC4F2', fontSize:14, fontWeight:700, textDecoration:'none', marginBottom:2 }}>
              Employee Login
            </a>
            <Link to="/admin" onClick={() => setMobileOpen(false)}
              style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 16px', borderRadius:12, color:'rgba(255,255,255,0.7)', fontSize:14, fontWeight:500, textDecoration:'none' }}>
              Admin Login
            </Link>
          </div>
        </nav>

        <div style={{ padding:'12px 16px', borderTop:'1px solid rgba(255,255,255,0.08)', display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <a href="tel:+918122257307" style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, backgroundColor:'rgba(123,63,173,0.2)', color:'white', padding:'10px 0', borderRadius:12, fontSize:12, fontWeight:700, textDecoration:'none' }}>
            <FaPhone size={11} /> Call
          </a>
          <a href="https://wa.me/918122257307" target="_blank" rel="noreferrer"
             style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, backgroundColor:'rgba(37,211,102,0.15)', color:'white', padding:'10px 0', borderRadius:12, fontSize:12, fontWeight:700, textDecoration:'none' }}>
            <FaWhatsapp size={13} /> WhatsApp
          </a>
        </div>
      </div>
    </>
  )
}