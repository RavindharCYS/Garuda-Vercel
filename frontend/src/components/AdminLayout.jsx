// src/components/AdminLayout.jsx
import React, { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  FaHouse, FaBox, FaPlus, FaCloudArrowUp, FaUsers, FaTruck,
  FaClipboardList, FaGear, FaUser, FaXmark, FaArrowRightFromBracket, FaBars,
} from 'react-icons/fa6'
import { useAuth } from '../context/AuthContext.jsx'

const NAV = [
  { group:'Shipments', items:[
    { path:'/admin/dashboard', icon:FaHouse, label:'Dashboard' },
    { path:'/shipments',       icon:FaBox, label:'All Shipments' },
    { path:'/shipments/new',   icon:FaPlus, label:'New Shipment' },
    { path:'/shipments/bulk',  icon:FaCloudArrowUp, label:'Bulk Upload' },
  ]},
  { group:'Admin', adminOnly:true, items:[
    { path:'/admin/users',     icon:FaUsers, label:'Users' },
    { path:'/admin/carriers',  icon:FaTruck, label:'Carriers' },
    { path:'/admin/audit',     icon:FaClipboardList, label:'Audit Log' },
    { path:'/admin/settings',  icon:FaGear, label:'Settings' },
  ]},
  { group:'Account', items:[
    { path:'/profile', icon:FaUser, label:'My Profile' },
  ]},
]

export default function AdminLayout({ children }) {
  const { user, logout, isAdmin } = useAuth()
  const location = useLocation()
  const navigate  = useNavigate()
  const [open, setOpen] = useState(false)

  const doLogout = () => { logout(); navigate('/admin') }
  const isActive = (path) => location.pathname === path || (path !== '/shipments' && location.pathname.startsWith(path+'/'))

  const SidebarContent = () => (
    <>
      {/* Logo */}
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'0 20px', height:60, borderBottom:'1px solid rgba(255,255,255,0.07)', flexShrink:0 }}>
        <img src="/assets/logo.png" alt="" style={{ width:32, height:32, borderRadius:'50%', objectFit:'cover', flexShrink:0 }} />
        <div style={{ minWidth:0 }}>
          <div style={{ color:'white', fontWeight:700, fontSize:13, lineHeight:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>Garuda Express</div>
          <div style={{ color:'#7B3FAD', fontSize:8, textTransform:'uppercase', letterSpacing:'0.2em', marginTop:2 }}>{isAdmin?'Admin':'Employee'}</div>
        </div>
        <button onClick={()=>setOpen(false)} style={{ marginLeft:'auto', background:'none', border:'none', color:'rgba(255,255,255,0.3)', cursor:'pointer', fontSize:18, lineHeight:1, flexShrink:0, display:'flex' }} className="lg-hide"><FaXmark size={16} /></button>
      </div>

      {/* Nav */}
      <nav style={{ flex:1, padding:'12px 10px', overflowY:'auto' }}>
        {NAV.map(group => {
          if (group.adminOnly && !isAdmin) return null
          return (
            <div key={group.group} style={{ marginBottom:20 }}>
              <div style={{ fontSize:8, color:'rgba(255,255,255,0.25)', textTransform:'uppercase', letterSpacing:'0.2em', fontWeight:700, padding:'0 12px', marginBottom:6 }}>
                {group.group}
              </div>
              {group.items.map(item => {
                const active = isActive(item.path)
                return (
                  <Link key={item.path} to={item.path} onClick={()=>setOpen(false)}
                    style={{
                      display:'flex', alignItems:'center', gap:10,
                      padding:'10px 12px', borderRadius:12, marginBottom:2,
                      textDecoration:'none', fontSize:13, fontWeight:active?700:500,
                      backgroundColor:active?'rgba(123,63,173,0.25)':'transparent',
                      color:active?'white':'rgba(255,255,255,0.55)',
                      border:active?'1px solid rgba(123,63,173,0.35)':'1px solid transparent',
                      transition:'all 0.15s',
                    }}
                    onMouseEnter={e=>{ if(!active){ e.currentTarget.style.backgroundColor='rgba(255,255,255,0.05)'; e.currentTarget.style.color='rgba(255,255,255,0.85)' }}}
                    onMouseLeave={e=>{ if(!active){ e.currentTarget.style.backgroundColor='transparent'; e.currentTarget.style.color='rgba(255,255,255,0.55)' }}}>
                    <span style={{ fontSize:15, flexShrink:0, display:'flex' }}><item.icon size={15} /></span>
                    {item.label}
                  </Link>
                )
              })}
            </div>
          )
        })}
      </nav>

      {/* User footer */}
      <div style={{ padding:12, borderTop:'1px solid rgba(255,255,255,0.07)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', marginBottom:4 }}>
          <div style={{ width:32, height:32, borderRadius:'50%', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontSize:13, fontWeight:800, flexShrink:0 }}>
            {(user?.name?.[0] || 'U').toUpperCase()}
          </div>
          <div style={{ minWidth:0 }}>
            <div style={{ color:'white', fontSize:12, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{user?.name}</div>
            <div style={{ color:'rgba(255,255,255,0.35)', fontSize:10, textTransform:'capitalize' }}>{user?.role}</div>
          </div>
        </div>
        <button onClick={doLogout}
          style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'none', border:'none', color:'rgba(255,255,255,0.35)', fontSize:12, cursor:'pointer', borderRadius:8, transition:'all 0.15s' }}
          onMouseEnter={e=>{ e.currentTarget.style.backgroundColor='rgba(220,38,38,0.1)'; e.currentTarget.style.color='#f87171' }}
          onMouseLeave={e=>{ e.currentTarget.style.backgroundColor='transparent'; e.currentTarget.style.color='rgba(255,255,255,0.35)' }}>
          <FaArrowRightFromBracket size={13} /> Sign Out
        </button>
      </div>
    </>
  )

  return (
    <div style={{ minHeight:'100vh', backgroundColor:'#faf5ff', display:'flex' }}>
      {/* Desktop sidebar */}
      <aside style={{ width:220, backgroundColor:'#1a0820', display:'flex', flexDirection:'column', flexShrink:0, position:'sticky', top:0, height:'100vh' }} className="sidebar-desktop">
        <SidebarContent />
      </aside>

      {/* Mobile overlay */}
      {open && (
        <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.5)', zIndex:40 }} className="sidebar-overlay"
          onClick={()=>setOpen(false)} />
      )}

      {/* Mobile drawer */}
      <aside style={{ position:'fixed', top:0, left:0, bottom:0, width:220, backgroundColor:'#1a0820', display:'flex', flexDirection:'column', zIndex:50, transform:open?'translateX(0)':'translateX(-100%)', transition:'transform 0.3s ease' }} className="sidebar-mobile">
        <SidebarContent />
      </aside>

      {/* Main */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0, minHeight:'100vh' }}>
        {/* Topbar */}
        <header style={{ backgroundColor:'white', borderBottom:'1px solid #f0e8f9', height:56, display:'flex', alignItems:'center', padding:'0 20px', gap:12, position:'sticky', top:0, zIndex:20, flexShrink:0 }}>
          {/* Hamburger (mobile only) */}
          <button onClick={()=>setOpen(true)} style={{ background:'none', border:'none', color:'#766D82', cursor:'pointer', fontSize:22, lineHeight:1, flexShrink:0, padding:4, display:'flex' }} className="hamburger-btn">
            <FaBars size={19} />
          </button>
          {/* Breadcrumb */}
          <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'#9ca3af', minWidth:0, overflow:'hidden' }}>
            <a href="/" style={{ color:'#9ca3af', textDecoration:'none', whiteSpace:'nowrap', display:'inline-flex', alignItems:'center', gap:5 }}><FaHouse size={11} /> Public</a>
            <span>/</span>
            <span style={{ color:'#374151', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {location.pathname.split('/').filter(Boolean).map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join(' › ') || 'Dashboard'}
            </span>
          </div>
          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:12, color:'#9ca3af' }} className="date-hide">
              {new Date().toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'})}
            </span>
            <div style={{ width:32, height:32, borderRadius:'50%', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontSize:13, fontWeight:800, flexShrink:0 }}>
              {(user?.name?.[0]||'U').toUpperCase()}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex:1, padding:'20px', overflowAuto:'scroll' }}>
          {children}
        </main>
      </div>

      <style>{`
        .sidebar-desktop { display: flex !important; }
        .sidebar-mobile  { display: flex !important; }
        .sidebar-overlay { display: block !important; }
        .hamburger-btn   { display: none !important; }
        .lg-hide         { display: none !important; }
        @media (max-width: 1023px) {
          .sidebar-desktop { display: none !important; }
          .hamburger-btn   { display: block !important; }
          .lg-hide         { display: block !important; }
          .date-hide       { display: none !important; }
        }
        @media (min-width: 1024px) {
          .sidebar-mobile  { display: none !important; }
          .sidebar-overlay { display: none !important; }
        }
      `}</style>
    </div>
  )
}
