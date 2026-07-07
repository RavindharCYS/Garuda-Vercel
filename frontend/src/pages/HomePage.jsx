// src/pages/HomePage.jsx
import React, { useState, useEffect, useRef } from 'react'
import Navbar   from '../components/Navbar.jsx'
import Footer   from '../components/Footer.jsx'
import Partners from '../components/Partners.jsx'
import reviews  from '../data/reviews.json'
import {
  FaGlobe, FaTruck, FaPlane, FaSuitcaseRolling, FaBoxOpen, FaPills,
  FaBolt, FaHouse, FaShieldHalved, FaSackDollar, FaHeadset,
  FaCalendarDays, FaHandshake, FaTruckFast, FaCircleCheck,
  FaPhone, FaWhatsapp, FaLocationDot, FaEnvelope, FaClock,
  FaArrowUp, FaArrowRotateRight, FaSpinner, FaTriangleExclamation,
  FaStar, FaCheck, FaBarcode, FaCircleInfo,
} from 'react-icons/fa6'

const API_URL = import.meta.env.VITE_API_URL || ''

// ── Shared scroll/motion hooks ────────────────────────────────────────────────
function useInView(threshold = 0.18) {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return }
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setInView(true); obs.disconnect() }
    }, { threshold })
    obs.observe(el)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, inView]
}

// Fade/rise wrapper used to stagger sections and cards in as they scroll into view.
function Reveal({ children, delay = 0, y = 22, as: Tag = 'div', style = {} }) {
  const [ref, inView] = useInView()
  return (
    <Tag
      ref={ref}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? 'translateY(0) scale(1)' : `translateY(${y}px) scale(0.98)`,
        transition: `opacity 0.7s cubic-bezier(.16,.84,.44,1) ${delay}ms, transform 0.7s cubic-bezier(.16,.84,.44,1) ${delay}ms`,
        willChange: 'opacity, transform',
        ...style,
      }}
    >
      {children}
    </Tag>
  )
}

// Counts up to `value` once its container scrolls into view.
function CountNumber({ value, suffix = '', inView, duration = 1400 }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!inView) return
    let raf
    const start = performance.now()
    const animate = (t) => {
      const p = Math.min((t - start) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setN(Math.floor(eased * value))
      if (p < 1) raf = requestAnimationFrame(animate)
    }
    raf = requestAnimationFrame(animate)
    return () => raf && cancelAnimationFrame(raf)
  }, [inView, value, duration])
  return <>{n}{suffix}</>
}

// ── Global CSS additions (responsive overrides, micro-interactions, etc.) ────
function GlobalEnhancements() {
  return (
    <style>{`
      @keyframes pulseDot { 0%,100% { box-shadow: 0 0 0 0 rgba(123,63,173,0.45); } 50% { box-shadow: 0 0 0 9px rgba(123,63,173,0); } }
      @keyframes floatY { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-8px) scale(1.015); } }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes shimmerSweep { 0% { transform: translateX(-120%) skewX(-12deg); } 100% { transform: translateX(220%) skewX(-12deg); } }

      .faq-item { border-bottom: 1px solid #f0e8f9; }
      .faq-q { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 16px; background: none; border: none; text-align: left; padding: 22px 4px; cursor: pointer; font-size: 16px; font-weight: 700; color: #1a0820; font-family: inherit; }
      .faq-icon { flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%; background: rgba(123,63,173,0.1); color: #7B3FAD; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 800; transition: transform 0.35s cubic-bezier(.34,1.56,.64,1), background-color 0.3s ease; }
      .faq-q:hover .faq-icon { background: rgba(123,63,173,0.18); }
      .faq-answer { max-height: 0; overflow: hidden; transition: max-height 0.35s ease, opacity 0.3s ease, padding 0.35s ease; opacity: 0; }
      .faq-answer.open { max-height: 280px; opacity: 1; }

      .sticky-cta { display: none; }
      .pulse-dot { animation: pulseDot 2s ease-in-out infinite; }

      /* Icon-badge micro-interactions */
      .icon-badge { transition: transform 0.45s cubic-bezier(.34,1.56,.64,1), box-shadow 0.35s ease; }
      .service-card:hover .icon-badge { transform: scale(1.12) rotate(-8deg); box-shadow: 0 12px 26px rgba(123,63,173,0.28); }
      .why-item:hover .icon-badge { transform: scale(1.1) rotate(8deg); }
      .process-icon { transition: transform 0.45s cubic-bezier(.34,1.56,.64,1), box-shadow 0.4s ease; }
      .process-step:hover .process-icon { transform: scale(1.08); box-shadow: 0 16px 32px rgba(123,63,173,0.35); }

      /* Primary buttons: lift on hover + soft shimmer sweep */
      .btn-primary { position: relative; overflow: hidden; transition: transform 0.25s ease, box-shadow 0.25s ease; }
      .btn-primary:hover { transform: translateY(-3px); box-shadow: 0 14px 30px rgba(123,63,173,0.4); }
      .btn-primary::after { content:''; position:absolute; top:0; left:0; width:40%; height:100%; background:linear-gradient(115deg,transparent,rgba(255,255,255,0.22),transparent); transform: translateX(-120%) skewX(-12deg); }
      .btn-primary:hover::after { animation: shimmerSweep 0.9s ease; }
      .btn-secondary { transition: transform 0.25s ease, background-color 0.25s ease, border-color 0.25s ease; }
      .btn-secondary:hover { transform: translateY(-3px); }

      a, button { -webkit-tap-highlight-color: transparent; }
      a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid #7B3FAD; outline-offset: 2px; }

      /* ── Responsive grid systems (Services / Why Choose / Process) ──────────
         Desktop default below; tablet + mobile overrides follow in their own
         media queries so column counts step down predictably at each size. */
      .services-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
      .why-grid       { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px 32px; }
      .process-grid   { display: grid; grid-template-columns: repeat(4, 1fr); gap: 48px 32px; align-items: start; }
      .process-step   { position: relative; text-align: center; }

      /* Dotted connector between process steps — desktop (4-in-a-row) only,
         drawn with ::after so it never depends on manually computed flex widths. */
      @media (min-width: 1025px) {
        .process-step:not(:last-child)::after {
          content: '';
          position: absolute;
          top: 32px;
          left: calc(50% + 56px);
          width: calc(100% - 64px);
          height: 2px;
          background: repeating-linear-gradient(90deg, rgba(123,63,173,0.25) 0 6px, transparent 6px 12px);
        }
      }

      /* ── Tablet (641px–1024px) ── */
      @media (min-width: 641px) and (max-width: 1024px) {
        .services-grid { grid-template-columns: repeat(2, 1fr); }
        .why-grid       { grid-template-columns: repeat(2, 1fr); }
        .process-grid   { grid-template-columns: repeat(2, 1fr); row-gap: 56px; }
      }

      /* ── Mobile (≤640px) ── */
      @media (max-width: 640px) {
        .stat-grid { grid-template-columns: repeat(2,1fr) !important; gap: 22px 16px !important; margin-top: 28px !important; padding-top: 24px !important; }
        .hero-section { min-height: auto !important; padding-top: 96px !important; padding-bottom: 40px !important; }
        .hero-title { margin-bottom: 12px !important; }
        .hero-subtitle { margin-bottom: 28px !important; }
        .hero-orb { width: 260px !important; height: 260px !important; }
        .hero-track-row { flex-direction: column !important; }
        .hero-track-btn { width: 100% !important; justify-content: center !important; }
        .services-grid { grid-template-columns: 1fr !important; gap: 20px !important; }
        .why-grid { grid-template-columns: 1fr !important; gap: 24px !important; }
        .process-grid { grid-template-columns: 1fr !important; gap: 40px !important; }
        .process-icon { width: 56px !important; height: 56px !important; }
        .back-to-top { bottom: 80px !important; right: 16px !important; }
        .mobile-bottom-spacer { height: 64px !important; }
      }

      @media (max-width: 640px) {
        .sticky-cta { display: flex !important; position: fixed; left: 0; right: 0; bottom: 0; z-index: 70; box-shadow: 0 -6px 24px rgba(0,0,0,0.18); padding-bottom: env(safe-area-inset-bottom, 0px); }
      }

      @media (prefers-reduced-motion: reduce) {
        .pulse-dot { animation: none !important; }
        .icon-badge, .process-icon, .btn-primary, .btn-secondary { transition: none !important; }
        .btn-primary:hover::after { animation: none !important; }
      }
    `}</style>
  )
}

// ── GE number input with validation ──────────────────────────────────────────
function GEInput({ value, onChange, onSubmit }) {
  const [touched, setTouched] = useState(false)

  // Enforce: GE + up to 7 digits only
  const handleChange = (e) => {
    let v = e.target.value.toUpperCase().replace(/[^GE0-9]/g, '')
    // Must start with GE
    if (v && !v.startsWith('G')) v = 'GE' + v.replace(/[^0-9]/g,'')
    if (v.startsWith('G') && !v.startsWith('GE')) v = 'GE' + v.slice(1).replace(/[^0-9]/g,'')
    // After GE, only digits, max 7
    if (v.startsWith('GE')) {
      const digits = v.slice(2).replace(/[^0-9]/g,'').slice(0, 7)
      v = 'GE' + digits
    }
    onChange(v)
    setTouched(true)
  }

  const isValid = /^GE\d{7}$/.test(value)
  const hasInput = value.length > 0
  const showErr  = touched && hasInput && !isValid

  return (
    <div style={{ flex:1, minWidth:220, position:'relative' }}>
      <div style={{ position:'absolute', left:20, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', opacity:0.4, display:'flex' }}>
        <FaBarcode size={18} color="white" />
      </div>
      <input
        value={value}
        onChange={handleChange}
        onKeyDown={e => e.key === 'Enter' && onSubmit()}
        onFocus={() => { if (!value) onChange('GE') }}
        placeholder="GE2847391"
        maxLength={9}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
        inputMode="text"
        style={{
          width:'100%', paddingLeft:52, paddingRight:20, paddingTop:18, paddingBottom:18,
          backgroundColor:'rgba(255,255,255,0.1)', border:`1.5px solid ${showErr?'rgba(239,68,68,0.6)':isValid?'rgba(123,63,173,0.7)':'rgba(255,255,255,0.12)'}`,
          borderRadius:16, color:'white', fontSize:18, fontFamily:'monospace', fontWeight:700, outline:'none',
          transition:'border-color 0.2s', letterSpacing:'0.05em', boxSizing:'border-box',
        }}
      />
      {showErr && (
        <div style={{ position:'absolute', bottom:-22, left:4, fontSize:11, color:'rgba(239,68,68,0.9)', fontWeight:600 }}>
          Format: GE + 7 digits (e.g. GE2847391)
        </div>
      )}
      {isValid && (
        <div style={{ position:'absolute', right:16, top:'50%', transform:'translateY(-50%)', color:'#4ade80', display:'flex', animation:'fadeUp 0.3s ease' }}>
          <FaCheck size={16} />
        </div>
      )}
    </div>
  )
}

// ── Tracking result ───────────────────────────────────────────────────────────
function TrackingResult({ data, geNum, onRefresh }) {
  const { shipment, trackingData } = data
  const status = trackingData?.currentStatus || 'Processing'

  const STATUS_COLORS = {
    'Delivered':         { dot:'#10b981', text:'#10b981', bg:'rgba(16,185,129,0.08)', border:'rgba(16,185,129,0.25)' },
    'Out for Delivery':  { dot:'#3b82f6', text:'#60a5fa', bg:'rgba(59,130,246,0.08)', border:'rgba(59,130,246,0.25)' },
    'In Transit':        { dot:'#3b82f6', text:'#60a5fa', bg:'rgba(59,130,246,0.08)', border:'rgba(59,130,246,0.25)' },
    'Picked Up':         { dot:'#a78bfa', text:'#a78bfa', bg:'rgba(167,139,250,0.08)', border:'rgba(167,139,250,0.25)' },
    'Exception':         { dot:'#f87171', text:'#f87171', bg:'rgba(248,113,113,0.08)', border:'rgba(248,113,113,0.25)' },
    'Returned':          { dot:'#9ca3af', text:'#9ca3af', bg:'rgba(156,163,175,0.08)', border:'rgba(156,163,175,0.25)' },
  }
  const sc = STATUS_COLORS[status] || { dot:'#f59e0b', text:'#f59e0b', bg:'rgba(245,158,11,0.08)', border:'rgba(245,158,11,0.25)' }
  const isLive = status === 'In Transit' || status === 'Out for Delivery'
  const events = (trackingData?.events || []).slice(0, 8)

  const fmt = ts => { try { return new Date(ts).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) } catch { return ts||'' } }

  return (
    <div style={{ border:`1px solid ${sc.border}`, borderRadius:16, overflow:'hidden', marginTop:16, animation:'fadeUp 0.4s ease' }}>
      {/* Status row */}
      <div style={{ backgroundColor:sc.bg, padding:'16px 20px', borderBottom:`1px solid ${sc.border}`, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div className={isLive ? 'pulse-dot' : ''} style={{ width:10, height:10, borderRadius:'50%', backgroundColor:sc.dot, boxShadow:`0 0 8px ${sc.dot}`, flexShrink:0 }} />
          <div>
            <div style={{ color:sc.text, fontWeight:800, fontSize:16 }}>{status}</div>
            <div style={{ color:'rgba(255,255,255,0.35)', fontSize:10, textTransform:'uppercase', letterSpacing:'0.15em', marginTop:2 }}>
              Garuda Express · {geNum}
              {trackingData?.fromCache && <span style={{ marginLeft:8, backgroundColor:'rgba(255,255,255,0.08)', padding:'1px 6px', borderRadius:4, fontSize:9 }}>Cached</span>}
            </div>
          </div>
        </div>
        <button onClick={onRefresh} className="btn-secondary" style={{ background:'none', border:'none', color:sc.text, fontSize:11, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', gap:6, textTransform:'uppercase', letterSpacing:'0.1em', padding:8 }}>
          <FaArrowRotateRight size={11} /> Refresh
        </button>
      </div>

      {/* Meta */}
      {(shipment?.from_name || shipment?.to_name || trackingData?.weight || shipment?.ship_date) && (
        <div style={{ backgroundColor:'rgba(255,255,255,0.04)', padding:'12px 20px', borderBottom:'1px solid rgba(255,255,255,0.05)', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))', gap:12 }}>
          {shipment?.from_name && <div><div style={{ fontSize:9, color:'rgba(255,255,255,0.3)', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:3 }}>From</div><div style={{ fontSize:12, color:'rgba(255,255,255,0.7)', fontWeight:600 }}>{shipment.from_name}</div><div style={{ fontSize:10, color:'rgba(255,255,255,0.3)' }}>{[shipment.from_city,shipment.from_country].filter(Boolean).join(', ')}</div></div>}
          {shipment?.to_name   && <div><div style={{ fontSize:9, color:'rgba(255,255,255,0.3)', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:3 }}>To</div><div style={{ fontSize:12, color:'rgba(255,255,255,0.7)', fontWeight:600 }}>{shipment.to_name}</div><div style={{ fontSize:10, color:'rgba(255,255,255,0.3)' }}>{[shipment.to_city,shipment.to_country].filter(Boolean).join(', ')}</div></div>}
          {trackingData?.weight && <div><div style={{ fontSize:9, color:'rgba(255,255,255,0.3)', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:3 }}>Weight</div><div style={{ fontSize:12, color:'rgba(255,255,255,0.7)', fontWeight:600 }}>{trackingData.weight}</div></div>}
          {shipment?.ship_date  && <div><div style={{ fontSize:9, color:'rgba(255,255,255,0.3)', textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:3 }}>Ship Date</div><div style={{ fontSize:12, color:'rgba(255,255,255,0.7)', fontWeight:600 }}>{shipment.ship_date}</div></div>}
        </div>
      )}

      {/* Events */}
      <div style={{ padding:'16px 20px', maxHeight:260, overflowY:'auto' }}>
        <div style={{ fontSize:9, color:'rgba(255,255,255,0.3)', textTransform:'uppercase', letterSpacing:'0.15em', marginBottom:14 }}>
          Tracking History · {events.length} event{events.length!==1?'s':''}
        </div>
        {events.length === 0 ? (
          <p style={{ color:'rgba(255,255,255,0.3)', fontSize:13 }}>No tracking events yet. Check back soon.</p>
        ) : (
          <div style={{ position:'relative' }}>
            <div style={{ position:'absolute', left:10, top:0, bottom:0, width:1, backgroundColor:'rgba(255,255,255,0.08)' }} />
            {events.map((e,i) => (
              <div key={i} style={{ display:'flex', gap:16, marginBottom:16, position:'relative' }}>
                <div style={{ width:20, height:20, borderRadius:'50%', backgroundColor: i===0?sc.dot:'rgba(255,255,255,0.1)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, zIndex:1, marginTop:2 }}>
                  <div style={{ width:6, height:6, borderRadius:'50%', backgroundColor:'white', opacity:i===0?1:0.5 }} />
                </div>
                <div>
                  <div style={{ fontSize:13, fontWeight:i===0?700:400, color:i===0?'white':'rgba(255,255,255,0.6)' }}>{e.status}</div>
                  {e.location && (
                    <div style={{ fontSize:11, color:'rgba(255,255,255,0.3)', marginTop:2, display:'flex', alignItems:'center', gap:5 }}>
                      <FaLocationDot size={9} /> {e.location}
                    </div>
                  )}
                  <div style={{ fontSize:10, color:'rgba(255,255,255,0.2)', marginTop:2, fontFamily:'monospace' }}>{fmt(e.timestamp)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ backgroundColor:'rgba(255,255,255,0.02)', borderTop:'1px solid rgba(255,255,255,0.05)', padding:'10px 20px' }}>
        <span style={{ fontSize:10, color:'rgba(255,255,255,0.2)', textTransform:'uppercase', letterSpacing:'0.1em' }}>
          Powered by Garuda Express International
        </span>
      </div>
    </div>
  )
}

// ── Hero stats (animated count-up) ────────────────────────────────────────────
const HERO_STATS = [
  { value:500, suffix:'+', label:'Happy Clients' },
  { value:220, suffix:'+', label:'Countries' },
  { special:'24/7', label:'Support' },
  { value:10,  suffix:'K+', label:'Deliveries' },
]

function HeroStats() {
  const [ref, inView] = useInView(0.4)
  return (
    <div ref={ref} className="stat-grid" style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:24, marginTop:48, paddingTop:32, borderTop:'1px solid rgba(255,255,255,0.06)' }}>
      {HERO_STATS.map((s, i) => (
        <div key={s.label} style={{
          textAlign:'center',
          opacity: inView ? 1 : 0,
          transform: inView ? 'translateY(0)' : 'translateY(14px)',
          transition: `opacity 0.6s cubic-bezier(.16,.84,.44,1) ${i*90}ms, transform 0.6s cubic-bezier(.16,.84,.44,1) ${i*90}ms`,
        }}>
          <div style={{ color:'white', fontSize:'clamp(22px,4vw,32px)', fontWeight:800 }}>
            {s.special ? s.special : <CountNumber value={s.value} suffix={s.suffix} inView={inView} />}
          </div>
          <div style={{ color:'rgba(255,255,255,0.35)', fontSize:10, textTransform:'uppercase', letterSpacing:'0.15em', marginTop:4 }}>{s.label}</div>
        </div>
      ))}
    </div>
  )
}

// ── Hero tracker section ──────────────────────────────────────────────────────
function HeroTracker() {
  const [value,   setValue]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [result,  setResult]  = useState(null)

  const doTrack = async () => {
    const ge = value.trim().toUpperCase()
    if (!/^GE\d{7}$/.test(ge)) return
    setLoading(true); setError(null); setResult(null)
    try {
      const res  = await fetch(`${API_URL}/api/track/${encodeURIComponent(ge)}`)
      const json = await res.json()
      if (!json.success) setError(json.error || json.hint || 'Tracking number not found.')
      else setResult(json)
    } catch { setError('Connection error. Please try again.') }
    finally { setLoading(false) }
  }

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const t = p.get('track') || p.get('ge')
    if (t) { setValue(t.trim().toUpperCase()); setTimeout(() => doTrack(), 800) }
  }, [])

  const canTrack = /^GE\d{7}$/.test(value)

  return (
    <section id="track" className="hero-section" style={{ background:'linear-gradient(160deg,#1a0820 0%,#2d1040 45%,#3d1f5c 100%)', minHeight:'88vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'60px 20px', position:'relative', overflow:'hidden' }}>
      {/* Orbs */}
      <div className="hero-orb" style={{ position:'absolute', top:-120, right:-120, width:500, height:500, borderRadius:'50%', background:'radial-gradient(circle,rgba(123,63,173,0.15) 0%,transparent 70%)', pointerEvents:'none', animation:'floatY 8s ease-in-out infinite' }} />
      <div className="hero-orb" style={{ position:'absolute', bottom:-100, left:-100, width:400, height:400, borderRadius:'50%', background:'radial-gradient(circle,rgba(91,45,139,0.12) 0%,transparent 70%)', pointerEvents:'none', animation:'floatY 10s ease-in-out infinite 1s' }} />

      <div style={{ maxWidth:800, width:'100%', textAlign:'center', position:'relative', zIndex:1 }}>
        <h1 className="hero-title" style={{ color:'white', fontSize:'clamp(40px,7vw,80px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', lineHeight:1.1, marginBottom:16 }}>
          Swift Courier &amp;<br/>
          <em style={{ fontWeight:400, color:'#DFC4F2' }}>Global Delivery</em>
        </h1>
        <p className="hero-subtitle" style={{ color:'rgba(255,255,255,0.5)', fontSize:18, fontWeight:300, maxWidth:580, margin:'0 auto 48px', lineHeight:1.7 }}>
          Track your Garuda Express shipment in real-time. Domestic &amp; international courier across 220+ countries.
        </p>

        {/* Tracker card */}
        <div style={{ backgroundColor:'rgba(255,255,255,0.04)', backdropFilter:'blur(24px)', border:'1px solid rgba(123,63,173,0.2)', borderRadius:24, padding:'clamp(24px,4vw,40px)' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, color:'#a78bfa', fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.18em', marginBottom:20 }}>
            <FaCircleInfo size={15} />
            Live Shipment Tracker
          </div>

          <div className="hero-track-row" style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
            <GEInput value={value} onChange={setValue} onSubmit={doTrack} />
            <button onClick={() => doTrack()} disabled={loading || !canTrack} className="hero-track-btn btn-primary"
              style={{ padding:'18px 32px', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', borderRadius:16, fontSize:16, fontWeight:800, cursor:loading||!canTrack?'not-allowed':'pointer', opacity:loading||!canTrack?0.6:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8, flexShrink:0, boxShadow:'0 8px 24px rgba(123,63,173,0.3)', whiteSpace:'nowrap' }}>
              {loading ? <FaSpinner style={{ animation:'spin 0.8s linear infinite' }} /> : null}
              {loading ? 'Tracking…' : 'Track'}
            </button>
          </div>

          <p style={{ color:'rgba(255,255,255,0.25)', fontSize:11, marginTop:12, textAlign:'left', fontFamily:'monospace', letterSpacing:'0.05em' }}>
            Format: GE + 7 digits · e.g. GE2847391
          </p>

          {/* Results */}
          {(loading || error || result) && (
            <div style={{ marginTop:20, textAlign:'left' }}>
              {loading && (
                <div style={{ display:'flex', alignItems:'center', gap:12, color:'rgba(255,255,255,0.5)', fontSize:14, padding:'16px 0' }}>
                  <FaSpinner style={{ animation:'spin 1s linear infinite', fontSize:20 }} />
                  Fetching live tracking data…
                </div>
              )}
              {error && !loading && (
                <div style={{ backgroundColor:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:12, padding:16, display:'flex', gap:12 }}>
                  <FaTriangleExclamation size={18} color="#f87171" style={{ flexShrink:0, marginTop:2 }} />
                  <div>
                    <div style={{ color:'#f87171', fontWeight:700, marginBottom:4 }}>Not found</div>
                    <div style={{ color:'rgba(248,113,113,0.7)', fontSize:12 }}>{error}</div>
                  </div>
                </div>
              )}
              {result && !loading && <TrackingResult data={result} geNum={value} onRefresh={() => doTrack()} />}
            </div>
          )}
        </div>

        <HeroStats />
      </div>
      <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </section>
  )
}

// ── Services ──────────────────────────────────────────────────────────────────
const SERVICES = [
  { n:'01', icon:FaGlobe,            title:'International Courier',    desc:'Door-to-door express to 220+ countries via DHL, UPS, FedEx, Aramex and more.' },
  { n:'02', icon:FaTruck,            title:'Domestic Delivery',        desc:'Fast PAN-India delivery via BlueDart, DTDC, Delhivery, Trackon, and Ekart.' },
  { n:'03', icon:FaPlane,            title:'Air Freight',              desc:'Market-leading air freight forwarding with competitive, monitored transit.' },
  { n:'04', icon:FaSuitcaseRolling,  title:'Excess Baggage',           desc:'Safe, economical excess baggage shipping — internationally or domestically.' },
  { n:'05', icon:FaBoxOpen,          title:'Free Pickup & Delivery',  desc:'We come to you. Free pickup from your doorstep — save time and money.' },
  { n:'06', icon:FaPills,            title:'Medicine & Time-Definite', desc:'Time-sensitive and medicine deliveries handled with precision and care.' },
]

function ServicesSection() {
  return (
    <section id="services" style={{ padding:'80px 20px', maxWidth:1200, margin:'0 auto' }}>
      <Reveal>
        <div style={{ textAlign:'center', marginBottom:64 }}>
          <span style={{ backgroundColor:'rgba(123,63,173,0.1)', color:'#7B3FAD', padding:'6px 16px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.2em' }}>What We Offer</span>
          <h2 style={{ fontSize:'clamp(32px,5vw,48px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', color:'#1a0820', margin:'16px 0 12px' }}>
            Our <em style={{ fontWeight:400 }}>Services</em>
          </h2>
          <p style={{ color:'#766D82', fontSize:17, maxWidth:520, margin:'0 auto' }}>Comprehensive courier solutions — local to global, all under one roof.</p>
        </div>
      </Reveal>
      <div className="services-grid">
        {SERVICES.map((s,i) => {
          const Icon = s.icon
          return (
            <Reveal key={s.n} delay={i*70}>
              <div className="service-card" style={{ backgroundColor:'white', border:'1px solid #f0e8f9', borderRadius:24, padding:'36px 32px', transition:'box-shadow 0.3s ease, transform 0.3s ease', cursor:'default', height:'100%', boxSizing:'border-box' }}
                onMouseEnter={e=>{ e.currentTarget.style.boxShadow='0 20px 48px rgba(123,63,173,0.12)'; e.currentTarget.style.transform='translateY(-4px)' }}
                onMouseLeave={e=>{ e.currentTarget.style.boxShadow='none'; e.currentTarget.style.transform='translateY(0)' }}>
                <div style={{ color:'rgba(123,63,173,0.2)', fontSize:40, fontWeight:700, fontStyle:'italic', marginBottom:16 }}>{s.n}</div>
                <div className="icon-badge" style={{ width:52, height:52, borderRadius:16, backgroundColor:'rgba(123,63,173,0.08)', display:'flex', alignItems:'center', justifyContent:'center', marginBottom:18 }}>
                  <Icon size={22} color="#7B3FAD" />
                </div>
                <h3 style={{ fontSize:18, fontWeight:700, color:'#1a0820', marginBottom:10 }}>{s.title}</h3>
                <p style={{ color:'#766D82', fontSize:14, lineHeight:1.7 }}>{s.desc}</p>
              </div>
            </Reveal>
          )
        })}
      </div>
    </section>
  )
}

// ── Why Choose Us ─────────────────────────────────────────────────────────────
const WHY_CHOOSE = [
  { icon:FaBolt,         title:'Real-Time Tracking',   desc:'Live GE-number updates at every checkpoint, from pickup to doorstep.' },
  { icon:FaHouse,         title:'Free Doorstep Pickup', desc:'We collect from your location at no extra cost, domestic or international.' },
  { icon:FaGlobe,         title:'220+ Countries',       desc:'A trusted global carrier network spanning every major trade route.' },
  { icon:FaShieldHalved,  title:'Secure & Insured',     desc:'Careful handling, with optional insurance for high-value shipments.' },
  { icon:FaSackDollar,    title:'Competitive Rates',    desc:'Transparent pricing with no hidden fees, for every shipment size.' },
  { icon:FaHeadset,       title:'24/7 Support',         desc:'Real people, real answers — call or WhatsApp us any time.' },
]

function WhyChooseSection() {
  return (
    <section style={{ backgroundColor:'#faf5ff', padding:'80px 20px' }}>
      <div style={{ maxWidth:1200, margin:'0 auto' }}>
        <Reveal>
          <div style={{ textAlign:'center', marginBottom:56 }}>
            <span style={{ backgroundColor:'rgba(123,63,173,0.1)', color:'#7B3FAD', padding:'6px 16px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.2em' }}>Why Garuda Express</span>
            <h2 style={{ fontSize:'clamp(30px,5vw,44px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', color:'#1a0820', margin:'16px 0 8px' }}>
              Built for <em style={{ fontWeight:400 }}>Peace of Mind</em>
            </h2>
          </div>
        </Reveal>
        <div className="why-grid">
          {WHY_CHOOSE.map((w,i) => {
            const Icon = w.icon
            return (
              <Reveal key={w.title} delay={i*60}>
                <div className="why-item" style={{ display:'flex', gap:16, alignItems:'flex-start' }}>
                  <div className="icon-badge" style={{ width:52, height:52, borderRadius:16, backgroundColor:'white', boxShadow:'0 6px 20px rgba(123,63,173,0.1)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <Icon size={20} color="#7B3FAD" />
                  </div>
                  <div>
                    <h3 style={{ fontSize:16, fontWeight:700, color:'#1a0820', marginBottom:6 }}>{w.title}</h3>
                    <p style={{ color:'#766D82', fontSize:13.5, lineHeight:1.7, margin:0 }}>{w.desc}</p>
                  </div>
                </div>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ── About ─────────────────────────────────────────────────────────────────────
function AboutSection() {
  return (
    <section id="about" style={{ backgroundColor:'white', padding:'80px 20px' }}>
      <div style={{ maxWidth:1200, margin:'0 auto', display:'grid', gridTemplateColumns:'1fr 1fr', gap:80, alignItems:'center' }} className="about-grid">
        <Reveal y={32}>
          <div style={{ position:'relative' }}>
            <div style={{ width:'100%', aspectRatio:'1', borderRadius:40, overflow:'hidden', border:'1px solid rgba(123,63,173,0.1)', backgroundColor:'#f5f0fa' }}>
              <img src="https://lh3.googleusercontent.com/aida-public/AB6AXuDYlamIilM2PzUUQU_aJYLyT7B3YKJci4T_3DvNUxsC49QEk4FduA7K1FnPj9uF9eYu6vyhqfENbkLTMN9IfVK-uNzlkSuM80mbWse-Hzs3nypsIyGkk-LQrd2oaEmtL4h-IEGjVyICb_GmMQXKiaT_uJ1plQp0lqXidLqnPbvOBCWC_6T9JkQeCvNjvJWQXKaGvHuntzCXzDsUYRt1Swp_P5AM1dwl1FrwEbwMezAckt16OdE0ZKNAkRngjDxIk9tpaYvxiDET9w"
                alt="Garuda Express Team" style={{ width:'100%', height:'100%', objectFit:'cover' }} loading="lazy" />
            </div>
            <div style={{ position:'absolute', right:-20, bottom:40, backgroundColor:'#1a0820', padding:'24px 32px', borderRadius:24, textAlign:'center', border:'1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ color:'#7B3FAD', fontSize:40, fontWeight:800, fontFamily:'"Cormorant Garamond",serif' }}>24/7</div>
              <div style={{ color:'rgba(255,255,255,0.5)', fontSize:9, textTransform:'uppercase', letterSpacing:'0.2em', marginTop:4 }}>Our Services</div>
            </div>
          </div>
        </Reveal>
        <Reveal delay={120}>
          <div>
            <span style={{ backgroundColor:'rgba(123,63,173,0.1)', color:'#7B3FAD', padding:'6px 16px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.2em' }}>Who We Are</span>
            <h2 style={{ fontSize:'clamp(30px,4vw,44px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', color:'#1a0820', margin:'16px 0 20px', lineHeight:1.15 }}>
              Best Courier &amp;<br/><em style={{ fontWeight:400 }}>Parcel Services</em>
            </h2>
            <p style={{ fontSize:18, color:'#1a0820', fontWeight:500, marginBottom:16, lineHeight:1.6 }}>
              Garuda Express — fast courier with free pickup &amp; delivery at your location.
            </p>
            <p style={{ color:'#766D82', marginBottom:32, lineHeight:1.8, fontSize:15 }}>
              Your one-stop for International and Domestic Courier Services. We aim to offer the best possible service at the lowest price, listening to clients large and small.
            </p>
            <ul style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, listStyle:'none', padding:0, margin:0 }}>
              {['International door-to-door','220+ countries covered','Online shipment tracking','Customs documentation support'].map(f => (
                <li key={f} style={{ display:'flex', alignItems:'flex-start', gap:8 }}>
                  <FaCheck size={13} color="#7B3FAD" style={{ flexShrink:0, marginTop:3 }} />
                  <span style={{ fontSize:14, fontWeight:500, color:'#374151' }}>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
      <style>{`.about-grid { grid-template-columns: 1fr !important; } @media(min-width:768px){.about-grid{grid-template-columns:1fr 1fr !important;}}`}</style>
    </section>
  )
}

// ── How It Works ───────────────────────────────────────────────────────────────
const PROCESS_STEPS = [
  { n:'01', icon:FaCalendarDays, title:'Book Pickup', desc:'Schedule online or call us — it takes under a minute.' },
  { n:'02', icon:FaHandshake,    title:'We Collect',  desc:'Our courier arrives at your doorstep, free of charge.' },
  { n:'03', icon:FaTruckFast,    title:'In Transit',  desc:'Track every checkpoint live with your GE tracking number.' },
  { n:'04', icon:FaCircleCheck,  title:'Delivered',   desc:'Safe, on-time delivery — signed, sealed, confirmed.' },
]

function ProcessSection() {
  return (
    <section style={{ padding:'80px 20px', backgroundColor:'white' }}>
      <div style={{ maxWidth:1100, margin:'0 auto' }}>
        <Reveal>
          <div style={{ textAlign:'center', marginBottom:64 }}>
            <span style={{ backgroundColor:'rgba(123,63,173,0.1)', color:'#7B3FAD', padding:'6px 16px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.2em' }}>The Process</span>
            <h2 style={{ fontSize:'clamp(30px,5vw,44px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', color:'#1a0820', margin:'16px 0 8px' }}>
              How It <em style={{ fontWeight:400 }}>Works</em>
            </h2>
          </div>
        </Reveal>
        <div className="process-grid">
          {PROCESS_STEPS.map((s, i) => {
            const Icon = s.icon
            return (
              <Reveal key={s.n} delay={i*100}>
                <div className="process-step">
                  <div className="process-icon" style={{ width:64, height:64, borderRadius:'50%', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px', boxShadow:'0 10px 24px rgba(123,63,173,0.25)' }}>
                    <Icon size={24} />
                  </div>
                  <div style={{ color:'rgba(123,63,173,0.35)', fontSize:13, fontWeight:800, marginBottom:4 }}>{s.n}</div>
                  <h3 style={{ fontSize:16, fontWeight:700, color:'#1a0820', marginBottom:8 }}>{s.title}</h3>
                  <p style={{ color:'#766D82', fontSize:13.5, lineHeight:1.7, maxWidth:220, margin:'0 auto' }}>{s.desc}</p>
                </div>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ── Reviews ───────────────────────────────────────────────────────────────────
function ReviewsSection() {
  return (
    <section id="testimonials" style={{ padding:'80px 20px', backgroundColor:'#faf5ff' }}>
      <div style={{ maxWidth:1200, margin:'0 auto' }}>
        <Reveal>
          <div style={{ textAlign:'center', marginBottom:56 }}>
            <span style={{ backgroundColor:'rgba(123,63,173,0.1)', color:'#7B3FAD', padding:'6px 16px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.2em' }}>Reviews</span>
            <h2 style={{ fontSize:'clamp(30px,5vw,44px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', color:'#1a0820', margin:'16px 0 8px' }}>
              Client <em style={{ fontWeight:400 }}>Testimonials</em>
            </h2>
          </div>
        </Reveal>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))', gap:24 }}>
          {reviews.slice(0,3).map((r,i) => (
            <Reveal key={r.id} delay={i*80}>
              <div style={{ backgroundColor:'white', borderRadius:32, padding:'40px 36px', position:'relative', overflow:'hidden', transition:'all 0.4s', cursor:'default', height:'100%', boxSizing:'border-box' }}
                onMouseEnter={e=>{ e.currentTarget.style.backgroundColor='#1a0820'; e.currentTarget.querySelector('.review-text').style.color='rgba(255,255,255,0.8)'; e.currentTarget.querySelector('.review-name').style.color='white'; e.currentTarget.querySelector('.review-role').style.color='rgba(255,255,255,0.4)' }}
                onMouseLeave={e=>{ e.currentTarget.style.backgroundColor='white'; e.currentTarget.querySelector('.review-text').style.color='#374151'; e.currentTarget.querySelector('.review-name').style.color='#1a0820'; e.currentTarget.querySelector('.review-role').style.color='#9ca3af' }}>
                <div style={{ color:'rgba(123,63,173,0.08)', fontSize:96, fontFamily:'serif', position:'absolute', top:-20, right:-10, lineHeight:1, userSelect:'none' }}>"</div>
                <div style={{ color:'#f59e0b', marginBottom:20, fontSize:14, display:'flex', gap:3 }}>
                  {Array.from({ length: r.rating }).map((_, idx) => <FaStar key={idx} size={13} />)}
                </div>
                <p className="review-text" style={{ color:'#374151', fontStyle:'italic', lineHeight:1.8, marginBottom:24, fontSize:15, transition:'color 0.3s' }}>"{r.review}"</p>
                <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ width:44, height:44, borderRadius:'50%', backgroundColor:'#7B3FAD', display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:800, fontSize:15, flexShrink:0 }}>{r.initials}</div>
                  <div>
                    <div className="review-name" style={{ fontWeight:700, color:'#1a0820', transition:'color 0.3s' }}>{r.name}</div>
                    <div className="review-role" style={{ fontSize:10, textTransform:'uppercase', letterSpacing:'0.12em', color:'#9ca3af', transition:'color 0.3s' }}>{r.role}</div>
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── FAQ ────────────────────────────────────────────────────────────────────────
const FAQS = [
  { q:'How do I track my shipment?', a:'Enter your GE tracking number (e.g. GE2847391) into the tracker above and hit Track. You will see live status and the full checkpoint history.' },
  { q:'How long does international delivery take?', a:'Most international shipments arrive within 3–7 business days, depending on destination, customs clearance, and the carrier used.' },
  { q:'Is pickup really free?', a:'Yes. We offer complimentary doorstep pickup for both domestic and international shipments — just book a slot and we will come to you.' },
  { q:'My tracking shows no updates yet — is that normal?', a:'Tracking data can take 24–48 hours to populate after pickup. If it is delayed longer than that, reach out to our support team.' },
  { q:'Which countries do you deliver to?', a:'We ship to 220+ countries through a network of trusted partners including DHL, UPS, FedEx, Aramex, and regional postal services.' },
]

function FAQItem({ item, isOpen, onClick }) {
  return (
    <div className="faq-item">
      <button className="faq-q" onClick={onClick} aria-expanded={isOpen}>
        <span>{item.q}</span>
        <span className="faq-icon" style={{ transform: isOpen ? 'rotate(45deg)' : 'rotate(0deg)' }}>+</span>
      </button>
      <div className={`faq-answer${isOpen ? ' open' : ''}`}>
        <p style={{ color:'#766D82', fontSize:14, lineHeight:1.8, margin:'0 4px 22px' }}>{item.a}</p>
      </div>
    </div>
  )
}

function FAQSection() {
  const [openIndex, setOpenIndex] = useState(0)
  return (
    <section style={{ padding:'80px 20px', backgroundColor:'white' }}>
      <div style={{ maxWidth:760, margin:'0 auto' }}>
        <Reveal>
          <div style={{ textAlign:'center', marginBottom:48 }}>
            <span style={{ backgroundColor:'rgba(123,63,173,0.1)', color:'#7B3FAD', padding:'6px 16px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.2em' }}>FAQ</span>
            <h2 style={{ fontSize:'clamp(28px,4vw,40px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', color:'#1a0820', margin:'16px 0 8px' }}>
              Common <em style={{ fontWeight:400 }}>Questions</em>
            </h2>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div>
            {FAQS.map((item, i) => (
              <FAQItem key={item.q} item={item} isOpen={openIndex === i} onClick={() => setOpenIndex(openIndex === i ? -1 : i)} />
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ── CTA ───────────────────────────────────────────────────────────────────────
function CTASection() {
  return (
    <section style={{ padding:'60px 20px' }}>
      <Reveal>
        <div style={{ maxWidth:900, margin:'0 auto', background:'linear-gradient(160deg,#1a0820,#2d1040,#3d1f5c)', borderRadius:40, padding:'clamp(40px,6vw,80px)', textAlign:'center', position:'relative', overflow:'hidden' }}>
          <div style={{ position:'absolute', top:-80, right:-80, width:300, height:300, borderRadius:'50%', background:'radial-gradient(circle,rgba(123,63,173,0.3),transparent)', pointerEvents:'none', animation:'floatY 9s ease-in-out infinite' }} />
          <span style={{ backgroundColor:'rgba(255,255,255,0.08)', color:'rgba(255,255,255,0.6)', padding:'6px 16px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.2em' }}>Get Started</span>
          <h2 style={{ color:'white', fontSize:'clamp(28px,5vw,52px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', margin:'20px 0 16px' }}>Ready to Ship?</h2>
          <p style={{ color:'rgba(255,255,255,0.55)', fontSize:16, maxWidth:480, margin:'0 auto 36px' }}>Free pickup from your location. Fast, secure delivery across 220+ countries.</p>
          <div style={{ display:'flex', gap:16, justifyContent:'center', flexWrap:'wrap' }}>
            <a href="tel:+918122257307" className="btn-primary" style={{ display:'inline-flex', alignItems:'center', gap:8, background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', padding:'14px 32px', borderRadius:50, fontSize:15, fontWeight:700, textDecoration:'none', boxShadow:'0 8px 24px rgba(123,63,173,0.35)' }}>
              <FaPhone size={14} /> Call Now
            </a>
            <a href="https://wa.me/918122257307" target="_blank" rel="noreferrer" className="btn-secondary"
              style={{ display:'inline-flex', alignItems:'center', gap:8, backgroundColor:'rgba(37,211,102,0.15)', border:'1.5px solid rgba(37,211,102,0.4)', color:'white', padding:'14px 32px', borderRadius:50, fontSize:15, fontWeight:700, textDecoration:'none' }}>
              <FaWhatsapp size={16} /> WhatsApp
            </a>
          </div>
        </div>
      </Reveal>
    </section>
  )
}

// ── Location ──────────────────────────────────────────────────────────────────
function LocationSection() {
  const contacts = [
    { icon:FaLocationDot, label:'Address', value:'Chennai, Tamil Nadu, India' },
    { icon:FaPhone,       label:'Phone 1', value:'+91 81222 57307', href:'tel:+918122257307' },
    { icon:FaPhone,       label:'Phone 2', value:'+91 95661 22447', href:'tel:+919566122447' },
    { icon:FaEnvelope,    label:'Email',   value:'info@garudaexpresscourier.com', href:'mailto:info@garudaexpresscourier.com' },
    { icon:FaClock,       label:'Hours',   value:'Mon–Sat: 9:00 AM – 7:00 PM' },
  ]
  return (
    <section id="location" style={{ backgroundColor:'white', padding:'80px 20px' }}>
      <div style={{ maxWidth:1200, margin:'0 auto', display:'grid', gridTemplateColumns:'1fr 1fr', gap:64, alignItems:'center' }} className="loc-grid">
        <Reveal>
          <div>
            <span style={{ backgroundColor:'rgba(123,63,173,0.1)', color:'#7B3FAD', padding:'6px 16px', borderRadius:50, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.2em' }}>Find Us</span>
            <h2 style={{ fontSize:'clamp(28px,4vw,40px)', fontWeight:700, fontFamily:'"Cormorant Garamond",serif', color:'#1a0820', margin:'16px 0 28px' }}>Our <em style={{ fontWeight:400 }}>Location</em></h2>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {contacts.map(c => {
                const Icon = c.icon
                return (
                  <div key={c.label} style={{ display:'flex', alignItems:'center', gap:14, backgroundColor:'#faf5ff', borderRadius:14, padding:'14px 18px' }}>
                    <div style={{ width:40, height:40, backgroundColor:'rgba(123,63,173,0.1)', borderRadius:12, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <Icon size={16} color="#7B3FAD" />
                    </div>
                    <div>
                      <div style={{ fontSize:9, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:2 }}>{c.label}</div>
                      {c.href ? <a href={c.href} style={{ fontSize:14, fontWeight:600, color:'#1a0820', textDecoration:'none' }}>{c.value}</a>
                               : <div style={{ fontSize:14, fontWeight:600, color:'#1a0820' }}>{c.value}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </Reveal>
        <Reveal delay={120}>
          <div style={{ borderRadius:28, overflow:'hidden', boxShadow:'0 20px 48px rgba(123,63,173,0.12)', border:'1px solid rgba(123,63,173,0.1)', height:420 }}>
            <iframe title="Garuda Express Location"
              src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d497698.99!2d79.7!3d13.0!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x3a5265ea4f7d3361%3A0x6e61a70b6863d433!2sChennai%2C%20Tamil%20Nadu!5e0!3m2!1sen!2sin!4v1"
              width="100%" height="100%" style={{ border:0 }} allowFullScreen loading="lazy" />
          </div>
        </Reveal>
      </div>
      <style>{`.loc-grid{grid-template-columns:1fr!important} @media(min-width:768px){.loc-grid{grid-template-columns:1fr 1fr!important}}`}</style>
    </section>
  )
}

// ── Back to top ───────────────────────────────────────────────────────────────
function BackToTop() {
  const [vis, setVis] = useState(false)
  useEffect(() => {
    const fn = () => setVis(window.scrollY > 400)
    window.addEventListener('scroll', fn, { passive:true })
    return () => window.removeEventListener('scroll', fn)
  }, [])
  return vis ? (
    <button onClick={() => window.scrollTo({top:0,behavior:'smooth'})} className="back-to-top btn-primary" aria-label="Back to top"
      style={{ position:'fixed', bottom:24, right:24, width:48, height:48, borderRadius:'50%', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', cursor:'pointer', boxShadow:'0 8px 24px rgba(123,63,173,0.3)', zIndex:50, display:'flex', alignItems:'center', justifyContent:'center', animation:'fadeUp 0.3s ease' }}>
      <FaArrowUp size={16} />
    </button>
  ) : null
}

// ── Sticky mobile call-to-action bar ──────────────────────────────────────────
function StickyMobileCTA() {
  return (
    <div className="sticky-cta">
      <a href="tel:+918122257307" style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'14px 0', fontSize:14, fontWeight:800, textDecoration:'none', color:'white', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)' }}>
        <FaPhone size={14} /> Call Now
      </a>
      <a href="https://wa.me/918122257307" target="_blank" rel="noreferrer" style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'14px 0', fontSize:14, fontWeight:800, textDecoration:'none', color:'white', backgroundColor:'#1f9d52' }}>
        <FaWhatsapp size={16} /> WhatsApp
      </a>
    </div>
  )
}

export default function HomePage() {
  return (
    <>
      <GlobalEnhancements />
      <Navbar />
      <main>
        <HeroTracker />
        <ServicesSection />
        <WhyChooseSection />
        <AboutSection />
        <Partners />
        <ProcessSection />
        <ReviewsSection />
        <FAQSection />
        <CTASection />
        <LocationSection />
        <div className="mobile-bottom-spacer" style={{ height:0 }} />
      </main>
      <Footer />
      <BackToTop />
      <StickyMobileCTA />
    </>
  )
}