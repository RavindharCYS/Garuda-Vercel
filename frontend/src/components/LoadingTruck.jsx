// src/components/LoadingTruck.jsx
import React from 'react'

export default function LoadingTruck({ text = 'Loading…', small = false }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, padding: small ? '32px 0' : '64px 0' }}>
      {/* Animated truck */}
      <div style={{ position:'relative', width:120, height:52, overflow:'hidden' }}>
        {/* Road */}
        <div style={{ position:'absolute', bottom:0, left:0, right:0, height:3, backgroundColor:'rgba(123,63,173,0.15)', borderRadius:50, overflow:'hidden' }}>
          <div style={{ height:'100%', width:'200%', display:'flex', gap:10, animation:'roadMove 0.6s linear infinite' }}>
            {Array.from({length:8}).map((_,i) => (
              <div key={i} style={{ width:18, height:3, backgroundColor:'rgba(123,63,173,0.4)', borderRadius:50, flexShrink:0 }} />
            ))}
          </div>
        </div>

        {/* Truck SVG */}
        <div style={{ position:'absolute', bottom:3, left:'50%', transform:'translateX(-50%)', animation:'truckBounce 1.2s ease-in-out infinite' }}>
          <svg width="56" height="32" viewBox="0 0 56 32" fill="none">
            {/* Body */}
            <rect x="0" y="6" width="38" height="20" rx="3" fill="#7B3FAD"/>
            {/* Cab */}
            <rect x="38" y="10" width="16" height="16" rx="3" fill="#5B2D8B"/>
            {/* Windshield */}
            <rect x="40" y="12" width="11" height="8" rx="1.5" fill="#DFC4F2" opacity="0.8"/>
            {/* GE label */}
            <text x="7" y="20" fontSize="7" fill="white" fontWeight="900" fontFamily="monospace">GE</text>
            {/* Front stripe */}
            <rect x="36" y="10" width="2" height="16" fill="#4a1a7a"/>
            {/* Wheels */}
            <circle cx="11" cy="28" r="4.5" fill="#1a0820"/>
            <circle cx="11" cy="28" r="2.5" fill="#7B3FAD"/>
            <circle cx="29" cy="28" r="4.5" fill="#1a0820"/>
            <circle cx="29" cy="28" r="2.5" fill="#7B3FAD"/>
            <circle cx="47" cy="28" r="4.5" fill="#1a0820"/>
            <circle cx="47" cy="28" r="2.5" fill="#7B3FAD"/>
            {/* Exhaust puffs */}
            <circle cx="-2" cy="14" r="3" fill="#DFC4F2" opacity="0.2"/>
            <circle cx="-6" cy="11" r="2" fill="#DFC4F2" opacity="0.12"/>
          </svg>
        </div>
      </div>

      <div style={{ textAlign:'center' }}>
        <div style={{ color:'#7B3FAD', fontWeight:700, fontSize:14 }}>{text}</div>
        <div style={{ display:'flex', gap:4, justifyContent:'center', marginTop:8 }}>
          {[0,150,300].map(d => (
            <div key={d} style={{ width:6, height:6, borderRadius:'50%', backgroundColor:'rgba(123,63,173,0.5)', animation:'dotPulse 1.2s ease-in-out infinite', animationDelay:`${d}ms` }} />
          ))}
        </div>
      </div>

      <style>{`
        @keyframes roadMove    { from{transform:translateX(0)} to{transform:translateX(-50%)} }
        @keyframes truckBounce { 0%,100%{transform:translateX(-50%) translateY(0)} 50%{transform:translateX(-50%) translateY(-2px)} }
        @keyframes dotPulse    { 0%,100%{opacity:0.3;transform:scale(0.8)} 50%{opacity:1;transform:scale(1)} }
      `}</style>
    </div>
  )
}
