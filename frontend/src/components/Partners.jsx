// src/components/Partners.jsx — Real carrier logos marquee, 4 rows each looping the full list
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import partnersData from '../data/partners.json'

// Visual scroll speed, in pixels/second. Using speed (not a fixed duration)
// means the loop paces identically whether the row renders wide (desktop)
// or narrow (mobile) — duration is derived from actual rendered width.
const BASE_SPEED = 36

// Picks readable text color (near-black or white) from the *actual* badge
// background, using relative luminance — instead of matching against a
// hardcoded list of "known gold hexes" that breaks for any new color choice.
function getReadableTextColor(hexColor) {
  if (!hexColor) return 'white'
  const hex = hexColor.replace('#', '')
  if (hex.length !== 6) return 'white'
  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#1a0820' : 'white'
}

// Renders a real logo image when partner.logo is provided, and falls back
// to a styled text/SVG badge if the field is missing or the image 404s —
// so a bad/broken URL never leaves a blank gap in the row.
function CarrierLogo({ partner }) {
  const { name, color, bg, abbr, label, logo } = partner
  const [imgFailed, setImgFailed] = useState(false)

  const wrap  = { display:'flex', flexDirection:'column', alignItems:'center', gap:4, flexShrink:0, padding:'0 14px' }
  const tag   = { fontSize:9, color:'#666', textTransform:'uppercase', letterSpacing:'0.1em', fontWeight:600 }

  // ── Real logo (preferred path) ──────────────────────────────────────────
  // Fixed width here is deliberate: if this were sized to the image's
  // natural dimensions, the row's total scrollWidth would shift the moment
  // each logo finishes loading (logos load asynchronously, at different
  // times). A mid-animation width change on the element the -50% transform
  // is relative to produces a visible snap/jump in the loop. Locking the
  // box to a fixed size means the row's width is known synchronously at
  // first paint and never moves, regardless of when images finish loading.
  if (logo && !imgFailed) {
    return (
      <div style={wrap}>
        <div style={{
          height:48, width:112, borderRadius:10, backgroundColor:'white',
          border:'1px solid #f0e8f9', display:'flex', alignItems:'center', justifyContent:'center',
          padding:'6px 14px', boxShadow:'0 2px 8px rgba(0,0,0,0.06)', boxSizing:'border-box',
        }}>
          <img
            src={logo}
            alt={name}
            decoding="async"
            draggable={false}
            onError={() => setImgFailed(true)}
            style={{ maxHeight:26, maxWidth:'100%', width:'auto', height:'auto', objectFit:'contain', display:'block' }}
          />
        </div>
        <span style={tag}>{label}</span>
      </div>
    )
  }

  const logoStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '8px 20px',
    borderRadius: 12,
    backgroundColor: color,
    minWidth: 90,
    height: 48,
    flexShrink: 0,
    position: 'relative',
    boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
  }

  // Text is what's actually shown on the badge — sizing and contrast should
  // both be computed from that, not from the (possibly much longer) brand name.
  const displayText = abbr || name
  const textStyle = {
    color: getReadableTextColor(color),
    fontWeight: 900,
    fontSize: displayText.length > 8 ? 11 : displayText.length > 6 ? 13 : 16,
    fontFamily: 'Arial Black, sans-serif',
    letterSpacing: '-0.02em',
    whiteSpace: 'nowrap',
  }

  // FedEx two-tone text
  if (name === 'FedEx') {
    return (
      <div style={wrap}>
        <div style={{ display:'flex', alignItems:'center', height:48 }}>
          <span style={{ fontFamily:'Arial Black,sans-serif', fontWeight:900, fontSize:22, color:'#4D148C', letterSpacing:'-0.03em' }}>Fed</span>
          <span style={{ fontFamily:'Arial Black,sans-serif', fontWeight:900, fontSize:22, color:'#FF6600', letterSpacing:'-0.03em' }}>Ex</span>
        </div>
        <span style={tag}>{label}</span>
      </div>
    )
  }

  // DHL yellow/red badge
  if (name === 'DHL') {
    return (
      <div style={wrap}>
        <div style={{ backgroundColor:'#D40511', padding:'6px 16px', borderRadius:8, height:48, display:'flex', alignItems:'center', boxShadow:'0 2px 8px rgba(212,5,17,0.25)' }}>
          <span style={{ color:'#FFCC00', fontFamily:'Arial Black,sans-serif', fontWeight:900, fontSize:22, letterSpacing:'0.05em' }}>DHL</span>
        </div>
        <span style={tag}>{label}</span>
      </div>
    )
  }

  // UPS brown/gold
  if (name === 'UPS') {
    return (
      <div style={wrap}>
        <div style={{ display:'flex', alignItems:'center', gap:6, height:48 }}>
          <svg width="32" height="36" viewBox="0 0 32 36" fill="none">
            <path d="M16 2 L30 8 L30 22 C30 30 16 36 16 36 C16 36 2 30 2 22 L2 8 Z" fill="#351C15"/>
            <path d="M16 5 L27 10 L27 22 C27 29 16 34 16 34 C16 34 5 29 5 22 L5 10 Z" fill="#F5A623"/>
            <text x="16" y="24" textAnchor="middle" fill="#351C15" fontFamily="Arial Black" fontWeight="900" fontSize="10">UPS</text>
          </svg>
          <span style={{ color:'#351C15', fontFamily:'Arial Black,sans-serif', fontWeight:900, fontSize:18 }}>UPS</span>
        </div>
        <span style={tag}>{label}</span>
      </div>
    )
  }

  // Blue Dart
  if (name === 'Blue Dart') {
    return (
      <div style={wrap}>
        <div style={{ height:48, display:'flex', alignItems:'center', gap:4 }}>
          <div style={{ width:8, height:30, backgroundColor:'#003087', borderRadius:2 }} />
          <div>
            <div style={{ color:'#003087', fontFamily:'Arial Black,sans-serif', fontWeight:900, fontSize:13, lineHeight:1 }}>Blue</div>
            <div style={{ color:'#E4002B', fontFamily:'Arial Black,sans-serif', fontWeight:900, fontSize:13, lineHeight:1 }}>Dart</div>
          </div>
        </div>
        <span style={tag}>{label}</span>
      </div>
    )
  }

  // Aramex
  if (name === 'Aramex') {
    return (
      <div style={wrap}>
        <div style={{ height:48, display:'flex', alignItems:'center' }}>
          <span style={{ color:'#EE3124', fontFamily:'Arial Black,sans-serif', fontWeight:900, fontSize:17, letterSpacing:'-0.02em' }}>aramex</span>
        </div>
        <span style={tag}>{label}</span>
      </div>
    )
  }

  // DTDC
  if (name === 'DTDC') {
    return (
      <div style={wrap}>
        <div style={{ height:48, display:'flex', alignItems:'center' }}>
          <div style={{ backgroundColor:'#E01C24', padding:'6px 14px', borderRadius:8, boxShadow:'0 2px 8px rgba(224,28,36,0.25)' }}>
            <span style={{ color:'white', fontFamily:'Arial Black,sans-serif', fontWeight:900, fontSize:17 }}>DTDC</span>
          </div>
        </div>
        <span style={tag}>{label}</span>
      </div>
    )
  }

  // Generic badge
  return (
    <div style={wrap}>
      <div style={logoStyle}>
        <span style={textStyle}>{abbr || name}</span>
      </div>
      <span style={tag}>{label}</span>
    </div>
  )
}

// Separator dot
function Sep() {
  return <div style={{ width:4, height:4, borderRadius:'50%', backgroundColor:'#e0d0f0', flexShrink:0, margin:'0 4px' }} />
}

// Rotates the array so it starts at a different index — used to give each
// row a different starting point through the *same full list*, rather than
// splitting the list into smaller, less-varied per-row subsets.
function rotateArray(arr, offset) {
  if (arr.length === 0) return arr
  const o = ((offset % arr.length) + arr.length) % arr.length
  return [...arr.slice(o), ...arr.slice(0, o)]
}

// Repeats a row's items until it's long enough to scroll smoothly, then
// doubles that sequence so the marquee can loop seamlessly at -50%.
function buildLoop(items, minLength = 12) {
  if (items.length === 0) return []
  const reps = Math.max(1, Math.ceil(minLength / items.length))
  const base = Array.from({ length: reps }, () => items).flat()
  return [...base, ...base]
}

// A single marquee row. Duration is derived from the row's *actual rendered
// width* (measured post-mount and on resize) divided by a fixed px/sec speed,
// rather than a hardcoded second count. That's what keeps the loop reading at
// the same, properly seamless pace whether it renders wide on desktop or
// compressed on mobile — width changes, perceived speed doesn't.
function MarqueeRow({ items, direction = 'left', speed = BASE_SPEED }) {
  const trackRef = useRef(null)
  const [duration, setDuration] = useState(40)
  const loop = useMemo(() => buildLoop(items), [items])

  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = () => {
      const halfWidth = el.scrollWidth / 2
      if (halfWidth > 0) setDuration(halfWidth / speed)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [speed, items])

  return (
    <div className="partners-row-wrap" style={{ overflow:'hidden', WebkitMaskImage:'linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)', maskImage:'linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)' }}>
      <div
        ref={trackRef}
        className={`partners-track${direction === 'right' ? ' partners-track-rev' : ''}`}
        style={{ display:'flex', alignItems:'center', width:'max-content', animationDuration:`${duration}s`, transform:'translateZ(0)', backfaceVisibility:'hidden' }}
      >
        {loop.map((p, i) => (
          <React.Fragment key={`${p.id}-${i}`}>
            <CarrierLogo partner={p} />
            <Sep />
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

export default function Partners() {
  const rowCount = 4
  // Each row gets the *entire* partner list, just rotated to a different
  // starting offset — so every row has full variety instead of a 4-brand
  // subset, and visually they don't all start on the same logo. Memoized so
  // the array references stay stable across re-renders (partnersData never
  // changes at runtime), which keeps each row's measurement/loop work from
  // being redone unnecessarily.
  const rows = useMemo(() => (
    Array.from({ length: rowCount }, (_, i) =>
      rotateArray(partnersData, Math.round((i * partnersData.length) / rowCount))
    )
  ), [])
  // Alternating directions and slightly different speeds per row reads as
  // organic rather than a single mirrored animation.
  const directions = ['left', 'right', 'left', 'right']
  const speeds     = [34, 30, 38, 32] // px/second per row

  return (
    <section style={{ padding:'64px 0', backgroundColor:'#fafafa', borderTop:'1px solid #f0e8f9', borderBottom:'1px solid #f0e8f9', overflow:'hidden' }} id="partners">
      <div style={{ textAlign:'center', marginBottom:32 }}>
        <span style={{ fontSize:10, color:'#999', textTransform:'uppercase', letterSpacing:'0.3em', fontWeight:700 }}>
          Our Carrier Network — Domestic &amp; International
        </span>
      </div>

      <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
        {rows.map((rowItems, i) => (
          <MarqueeRow
            key={i}
            items={rowItems}
            direction={directions[i % directions.length]}
            speed={speeds[i % speeds.length]}
          />
        ))}
      </div>

      <style>{`
        @keyframes marqueeScroll {
          0%   { transform: translate3d(0,0,0); }
          100% { transform: translate3d(-50%,0,0); }
        }
        .partners-row-wrap {
          contain: layout style paint;
        }
        .partners-track {
          animation-name: marqueeScroll;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          will-change: transform;
        }
        .partners-track-rev { animation-direction: reverse; }
        .partners-row-wrap:hover .partners-track { animation-play-state: paused; }

        @media (prefers-reduced-motion: reduce) {
          .partners-track { animation: none !important; }
        }

        @media (max-width: 640px) {
          .partners-row-wrap + .partners-row-wrap { margin-top: -2px; }
        }
      `}</style>
    </section>
  )
}