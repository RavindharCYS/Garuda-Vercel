// src/hooks/useConfirm.js — promise-based bridge to <ConfirmModal>, so plain
// (non-component) helper functions like utils/waybillDownload.js can ask
// "are you sure?" through the app's own modal instead of window.confirm(),
// while still reading as a simple `await confirm(...)` call at the call site.
//
// Usage in a component:
//   const { confirmState, confirm, handleConfirm, handleCancel } = useConfirm()
//   ...
//   const ok = await confirm({ title: 'Delete this?', message: '...', danger: true })
//   if (!ok) return
//   ...
//   <ConfirmModal
//     open={!!confirmState}
//     title={confirmState?.title}
//     message={confirmState?.message}
//     danger={confirmState?.danger}
//     confirmLabel={confirmState?.confirmLabel}
//     confirmPhrase={confirmState?.confirmPhrase}
//     onConfirm={handleConfirm}
//     onCancel={handleCancel}
//   />
import { useState, useCallback, useRef } from 'react'

export function useConfirm() {
  const [confirmState, setConfirmState] = useState(null)
  const resolver = useRef(null)

  /** @param {string|object} opts - a message string, or { title, message, danger, confirmLabel, confirmPhrase } */
  const confirm = useCallback((opts) => {
    const config = typeof opts === 'string' ? { message: opts } : opts
    setConfirmState(config)
    return new Promise((resolve) => { resolver.current = resolve })
  }, [])

  const handleConfirm = useCallback(() => {
    resolver.current?.(true)
    resolver.current = null
    setConfirmState(null)
  }, [])

  const handleCancel = useCallback(() => {
    resolver.current?.(false)
    resolver.current = null
    setConfirmState(null)
  }, [])

  return { confirmState, confirm, handleConfirm, handleCancel }
}