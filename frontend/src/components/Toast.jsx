// src/components/Toast.jsx — app-native success/error notification.
// Replaces window.alert() so notifications match the rest of the UI instead
// of looking like a raw OS/browser alert. Use with ../hooks/useToast.js:
//
//   const { toast, showToast } = useToast()
//   showToast('Saved!')                 // success (green)
//   showToast('Something failed', 'error')
//   ...
//   return <>
//     <Toast toast={toast} />
//     ...
//   </>
import React from 'react'
import { FaCheck, FaXmark } from 'react-icons/fa6'

export default function Toast({ toast }) {
  if (!toast) return null
  return (
    <>
      <style>{`@keyframes toastSlideIn { from { transform:translateY(-12px); opacity:0; } to { transform:translateY(0); opacity:1; } }`}</style>
      <div style={{
        position:'fixed', top:20, right:20, zIndex:2000, padding:'12px 20px', borderRadius:16,
        fontSize:13, fontWeight:700, boxShadow:'0 8px 24px rgba(0,0,0,0.15)', display:'flex',
        alignItems:'center', gap:8, backgroundColor: toast.type === 'error' ? '#dc2626' : '#059669',
        color:'white', animation:'toastSlideIn 0.3s ease', maxWidth:420,
      }}>
        {toast.type === 'error' ? <FaXmark size={13} /> : <FaCheck size={13} />} {toast.msg}
      </div>
    </>
  )
}