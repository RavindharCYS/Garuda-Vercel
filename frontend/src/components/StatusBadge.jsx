// src/components/StatusBadge.jsx
import React from 'react'

const STATUS_MAP = {
  'Delivered':            { bg:'rgba(16,185,129,0.1)',  border:'rgba(16,185,129,0.3)',  text:'#059669', dot:'#10b981' },
  'Out for Delivery':     { bg:'rgba(59,130,246,0.1)',  border:'rgba(59,130,246,0.3)',  text:'#2563eb', dot:'#3b82f6' },
  'In Transit':           { bg:'rgba(59,130,246,0.1)',  border:'rgba(59,130,246,0.3)',  text:'#2563eb', dot:'#3b82f6' },
  'Picked Up':            { bg:'rgba(139,92,246,0.1)', border:'rgba(139,92,246,0.3)', text:'#7c3aed', dot:'#8b5cf6' },
  'Processing':           { bg:'rgba(245,158,11,0.1)', border:'rgba(245,158,11,0.3)', text:'#d97706', dot:'#f59e0b' },
  'Information Received': { bg:'rgba(245,158,11,0.1)', border:'rgba(245,158,11,0.3)', text:'#d97706', dot:'#f59e0b' },
  'Exception':            { bg:'rgba(239,68,68,0.1)',  border:'rgba(239,68,68,0.3)',  text:'#dc2626', dot:'#ef4444' },
  'Returned':             { bg:'rgba(107,114,128,0.1)',border:'rgba(107,114,128,0.3)',text:'#4b5563', dot:'#6b7280' },
}

export default function StatusBadge({ status, size = 'sm' }) {
  const cfg = STATUS_MAP[status] || STATUS_MAP['Processing']
  const pad = size === 'sm' ? '3px 10px' : '5px 14px'
  const fs  = size === 'sm' ? 10 : 12

  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:5,
      backgroundColor:cfg.bg, border:`1px solid ${cfg.border}`,
      color:cfg.text, padding:pad, borderRadius:50,
      fontSize:fs, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em',
      whiteSpace:'nowrap'
    }}>
      <span style={{ width:6, height:6, borderRadius:'50%', backgroundColor:cfg.dot, flexShrink:0 }} />
      {status}
    </span>
  )
}
