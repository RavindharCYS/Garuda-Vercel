// src/components/ProtectedRoute.jsx
import React from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import LoadingTruck from './LoadingTruck.jsx'

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth()
  if (loading) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:'#faf5ff' }}>
      <LoadingTruck text="Authenticating…" />
    </div>
  )
  if (!user) return <Navigate to="/admin" replace />
  if (adminOnly && user.role !== 'admin') return <Navigate to="/shipments" replace />
  return children
}
