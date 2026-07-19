// src/hooks/useToast.js — tiny local-state toast helper, shared by any page
// that needs a non-blocking success/error notification instead of a native
// window.alert(). Pair with <Toast toast={toast} /> from
// ../components/Toast.jsx.
import { useState, useCallback } from 'react'

export function useToast() {
  const [toast, setToast] = useState(null)

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }, [])

  return { toast, showToast }
}