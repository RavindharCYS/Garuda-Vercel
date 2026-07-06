// src/App.jsx
import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext.jsx'
import ProtectedRoute   from './components/ProtectedRoute.jsx'

import HomePage          from './pages/HomePage.jsx'
import AdminLogin        from './pages/AdminLogin.jsx'
import ChangePassword    from './pages/ChangePassword.jsx'
import AdminDashboard    from './pages/AdminDashboard.jsx'
import ShipmentsPage     from './pages/ShipmentsPage.jsx'
import ShipmentDetail    from './pages/ShipmentDetail.jsx'
import NewShipment       from './pages/NewShipment.jsx'
import BulkUploadPage    from './pages/BulkUploadPage.jsx'
import AdminUsers        from './pages/AdminUsers.jsx'
import AuditLog          from './pages/AuditLog.jsx'
import CarrierManagement from './pages/CarrierManagement.jsx'
import SettingsPage      from './pages/SettingsPage.jsx'
import ProfilePage       from './pages/ProfilePage.jsx'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public */}
        <Route path="/"       element={<HomePage />} />
        {/* Single shared staff login — role-based redirect after auth.
            /Portal is an alias matching the requirement spec's named
            Employee Portal URL; both render the same sign-in screen. */}
        <Route path="/admin"  element={<AdminLogin />} />
        <Route path="/Portal" element={<AdminLogin />} />

        {/* Forced or self-service password change */}
        <Route path="/change-password" element={
          <ProtectedRoute><ChangePassword forced /></ProtectedRoute>
        }/>

        {/* Employee + Admin — dashboard renders role-appropriate widgets */}
        <Route path="/admin/dashboard" element={
          <ProtectedRoute><AdminDashboard /></ProtectedRoute>
        }/>
        <Route path="/shipments" element={
          <ProtectedRoute><ShipmentsPage /></ProtectedRoute>
        }/>
        <Route path="/shipments/new" element={
          <ProtectedRoute><NewShipment /></ProtectedRoute>
        }/>
        <Route path="/shipments/bulk" element={
          <ProtectedRoute><BulkUploadPage /></ProtectedRoute>
        }/>
        <Route path="/shipments/:id" element={
          <ProtectedRoute><ShipmentDetail /></ProtectedRoute>
        }/>
        <Route path="/profile" element={
          <ProtectedRoute><ProfilePage /></ProtectedRoute>
        }/>

        {/* Admin-only */}
        <Route path="/admin/users" element={
          <ProtectedRoute adminOnly><AdminUsers /></ProtectedRoute>
        }/>
        <Route path="/admin/audit" element={
          <ProtectedRoute adminOnly><AuditLog /></ProtectedRoute>
        }/>
        <Route path="/admin/carriers" element={
          <ProtectedRoute adminOnly><CarrierManagement /></ProtectedRoute>
        }/>
        <Route path="/admin/settings" element={
          <ProtectedRoute adminOnly><SettingsPage /></ProtectedRoute>
        }/>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
