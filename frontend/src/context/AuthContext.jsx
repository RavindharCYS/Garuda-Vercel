// src/context/AuthContext.jsx
import React, { createContext, useContext, useState, useEffect, useRef } from 'react'

const AuthContext = createContext(null)

const API_URL = import.meta.env.VITE_API_URL || ''

export function AuthProvider({ children }) {
  const [user,  setUser]  = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem('ge_token'))
  const [refreshToken, setRefreshToken] = useState(() => localStorage.getItem('ge_refresh'))
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [loading, setLoading] = useState(true)
  const tokenRef = useRef(token)
  tokenRef.current = token

  useEffect(() => {
    if (token) {
      fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => { if (d.success) setUser(d.user); else logout(); })
        .catch(logout)
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [token])

  const login = async (username, password) => {
    const res  = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    localStorage.setItem('ge_token', data.token)
    localStorage.setItem('ge_refresh', data.refreshToken)
    setToken(data.token)
    setRefreshToken(data.refreshToken)
    setUser(data.user)
    setMustChangePassword(!!data.mustChangePassword)
    return { ...data.user, mustChangePassword: !!data.mustChangePassword }
  }

  const logout = () => {
    localStorage.removeItem('ge_token')
    localStorage.removeItem('ge_refresh')
    setToken(null)
    setRefreshToken(null)
    setUser(null)
    setMustChangePassword(false)
  }

  // Attempts a single silent refresh using the stored refresh token.
  // Returns the new access token on success, or null on failure (caller should log out).
  const trySilentRefresh = async () => {
    const rt = localStorage.getItem('ge_refresh')
    if (!rt) return null
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt })
      })
      const data = await res.json()
      if (!data.success) return null
      localStorage.setItem('ge_token', data.token)
      localStorage.setItem('ge_refresh', data.refreshToken)
      setToken(data.token)
      setRefreshToken(data.refreshToken)
      return data.token
    } catch (_) { return null }
  }

  // authFetch: attaches the bearer token, and on a 401 transparently tries
  // ONE silent refresh + retry before giving up (logs out if that also fails).
  // NOTE: pass either a full URL (with API_URL already prefixed) or a path
  // starting with '/api/...' — this helper will prefix it with API_URL for you
  // if it's a relative path.
  const authFetch = async (url, opts = {}) => {
    const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`
    const doFetch = (tok) => fetch(fullUrl, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${tok}` } })

    let res = await doFetch(tokenRef.current)
    if (res.status === 401) {
      const newToken = await trySilentRefresh()
      if (newToken) {
        res = await doFetch(newToken)
      } else {
        logout()
      }
    }
    return res
  }

  const clearMustChangePassword = () => setMustChangePassword(false)

  return (
    <AuthContext.Provider value={{
      user, token, loading, mustChangePassword, login, logout, authFetch,
      clearMustChangePassword, isAdmin: user?.role === 'admin'
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)