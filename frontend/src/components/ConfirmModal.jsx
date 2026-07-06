// src/components/ConfirmModal.jsx — app-native confirmation dialog.
// Replaces browser-native window.confirm() popups so they match the rest of
// the UI instead of looking like a raw OS/browser alert.
import React from 'react'

export default function ConfirmModal({ open, title, message, confirmLabel='Confirm', cancelLabel='Cancel', danger=false, onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div onClick={onCancel} style={{
      position:'fixed', inset:0, backgroundColor:'rgba(26,8,32,0.55)', zIndex:1000,
      display:'flex', alignItems:'center', justifyContent:'center', padding:20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        backgroundColor:'white', borderRadius:20, maxWidth:440, width:'100%',
        padding:28, boxShadow:'0 20px 60px rgba(26,8,32,0.35)',
      }}>
        <h3 style={{ fontSize:17, fontWeight:800, color:'#1a0820', margin:'0 0 10px' }}>{title}</h3>
        <p style={{ fontSize:14, color:'#565062', lineHeight:1.6, margin:'0 0 24px', whiteSpace:'pre-line' }}>{message}</p>
        <div style={{ display:'flex', justifyContent:'flex-end', gap:10 }}>
          <button onClick={onCancel}
            style={{ padding:'10px 20px', borderRadius:12, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', fontSize:13, fontWeight:700, cursor:'pointer' }}>
            {cancelLabel}
          </button>
          <button onClick={onConfirm}
            style={{ padding:'10px 20px', borderRadius:12, border:'none', color:'white', fontSize:13, fontWeight:700, cursor:'pointer',
              background: danger ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : 'linear-gradient(135deg,#7B3FAD,#5B2D8B)' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}