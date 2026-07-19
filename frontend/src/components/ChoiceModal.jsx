// src/components/ChoiceModal.jsx — app-native "pick one" dialog, styled to
// match ConfirmModal. Use this instead of ConfirmModal when there are two or
// more distinct actions to choose between, rather than a single yes/no
// confirmation — e.g. "Export Visible Content" vs "Export Full Content".
import React from 'react'

/**
 * @param {boolean} open
 * @param {string} title
 * @param {string} [message]
 * @param {{ label: string, description?: string, onClick: () => void, primary?: boolean }[]} options
 * @param {string} [cancelLabel]
 * @param {() => void} onCancel
 */
export default function ChoiceModal({ open, title, message, options = [], cancelLabel = 'Cancel', onCancel }) {
  if (!open) return null
  return (
    <div onClick={onCancel} style={{
      position:'fixed', inset:0, backgroundColor:'rgba(26,8,32,0.55)', zIndex:1000,
      display:'flex', alignItems:'center', justifyContent:'center', padding:20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        backgroundColor:'white', borderRadius:20, maxWidth:460, width:'100%',
        padding:28, boxShadow:'0 20px 60px rgba(26,8,32,0.35)',
      }}>
        <h3 style={{ fontSize:17, fontWeight:800, color:'#1a0820', margin:'0 0 10px' }}>{title}</h3>
        {message && <p style={{ fontSize:14, color:'#565062', lineHeight:1.6, margin:'0 0 20px' }}>{message}</p>}

        <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:18 }}>
          {options.map((opt, i) => (
            <button key={i} onClick={opt.onClick}
              style={{
                textAlign:'left', padding:'14px 16px', borderRadius:14, cursor:'pointer',
                border: opt.primary ? 'none' : '1.5px solid #e5e7eb',
                background: opt.primary ? 'linear-gradient(135deg,#7B3FAD,#5B2D8B)' : 'white',
                color: opt.primary ? 'white' : '#1a0820',
              }}>
              <div style={{ fontSize:14, fontWeight:700 }}>{opt.label}</div>
              {opt.description && (
                <div style={{ fontSize:12, marginTop:3, color: opt.primary ? 'rgba(255,255,255,0.85)' : '#766D82' }}>
                  {opt.description}
                </div>
              )}
            </button>
          ))}
        </div>

        <div style={{ display:'flex', justifyContent:'flex-end' }}>
          <button onClick={onCancel}
            style={{ padding:'10px 20px', borderRadius:12, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', fontSize:13, fontWeight:700, cursor:'pointer' }}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  )
}