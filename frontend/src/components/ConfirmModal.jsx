// src/components/ConfirmModal.jsx — app-native confirmation dialog.
// Replaces browser-native window.confirm() popups so they match the rest of
// the UI instead of looking like a raw OS/browser alert.
//
// Optional GitHub-style "type to confirm" mode: pass `confirmPhrase` and the
// Confirm button stays disabled until the person types that exact phrase
// into the input — the same pattern GitHub uses for deleting a repo.
import React, { useState, useEffect } from 'react'

export default function ConfirmModal({ open, title, message, confirmLabel='Confirm', cancelLabel='Cancel', danger=false, confirmPhrase=null, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('')

  // Reset the typed text whenever the modal opens/closes so a stale value
  // from a previous open can't leave the button pre-enabled.
  useEffect(() => { if (open) setTyped('') }, [open])

  if (!open) return null

  const requiresTyping = !!confirmPhrase
  const canConfirm = !requiresTyping || typed === confirmPhrase

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

        {requiresTyping && (
          <div style={{ marginBottom:24 }}>
            <label style={{ display:'block', fontSize:12, color:'#565062', marginBottom:8 }}>
              Type <strong style={{ color:'#1a0820', fontFamily:'monospace' }}>{confirmPhrase}</strong> to confirm:
            </label>
            <input
              autoFocus
              value={typed}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canConfirm) onConfirm() }}
              placeholder={confirmPhrase}
              style={{ width:'100%', border:'1.5px solid #e5e7eb', borderRadius:10, padding:'10px 14px', fontSize:14, outline:'none', boxSizing:'border-box', fontFamily:'monospace' }}
            />
          </div>
        )}

        <div style={{ display:'flex', justifyContent:'flex-end', gap:10 }}>
          <button onClick={onCancel}
            style={{ padding:'10px 20px', borderRadius:12, border:'1.5px solid #e5e7eb', backgroundColor:'white', color:'#374151', fontSize:13, fontWeight:700, cursor:'pointer' }}>
            {cancelLabel}
          </button>
          <button onClick={onConfirm} disabled={!canConfirm}
            style={{ padding:'10px 20px', borderRadius:12, border:'none', color:'white', fontSize:13, fontWeight:700,
              cursor: canConfirm ? 'pointer' : 'not-allowed', opacity: canConfirm ? 1 : 0.5,
              background: danger ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : 'linear-gradient(135deg,#7B3FAD,#5B2D8B)' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}