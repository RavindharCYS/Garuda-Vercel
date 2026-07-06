// src/pages/SettingsPage.jsx
import React, { useState, useEffect } from 'react'
import { FaArrowRotateRight, FaArrowRight, FaCheck, FaTriangleExclamation, FaSatelliteDish, FaBoxArchive, FaBell, FaCircleDot, FaCopy } from 'react-icons/fa6'
import AdminLayout from '../components/AdminLayout.jsx'
import ConfirmModal from '../components/ConfirmModal.jsx'
import { useAuth } from '../context/AuthContext.jsx'

function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom:18 }}>
      <label style={{ display:'block', fontSize:10, color:'#7B3FAD', textTransform:'uppercase', letterSpacing:'0.12em', fontWeight:700, marginBottom:6 }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize:11, color:'#9ca3af', marginTop:4 }}>{hint}</p>}
    </div>
  )
}

function SectionCard({ title, icon, children }) {
  return (
    <div style={{ backgroundColor:'white', borderRadius:20, padding:24, border:'1px solid #f0e8f9' }}>
      <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16, display:'flex', alignItems:'center', gap:8 }}>
        {icon}{title}
      </h2>
      {children}
    </div>
  )
}

function CopyableUrl({ url }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(()=>setCopied(false), 2000) }) }
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <code style={{ flex:1, fontSize:12, backgroundColor:'#faf5ff', padding:'8px 12px', borderRadius:8, color:'#1a0820', overflowX:'auto', whiteSpace:'nowrap' }}>{url}</code>
      <button onClick={copy} title="Copy" style={{ padding:'8px 10px', borderRadius:8, border:'1.5px solid #e5e7eb', backgroundColor:'white', cursor:'pointer', color: copied ? '#059669' : '#7B3FAD', flexShrink:0 }}>
        {copied ? <FaCheck size={12} /> : <FaCopy size={12} />}
      </button>
    </div>
  )
}

export default function SettingsPage() {
  const { authFetch } = useAuth()
  const [settings, setSettings] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [retentionWarning, setRetentionWarning] = useState(null)
  const [apiUsage, setApiUsage] = useState(null)

  const load = () => {
    setLoading(true)
    Promise.all([
      authFetch('/api/admin/settings').then(r=>r.json()),
      authFetch('/api/notifications?limit=10').then(r=>r.json()).catch(()=>({data:[]})),
      authFetch('/api/admin/retention-warning').then(r=>r.json()).catch(()=>({pending:false})),
      authFetch('/api/admin/api-usage').then(r=>r.json()).catch(()=>null),
    ]).then(([s, n, rw, usage]) => {
      if (s.success) setSettings(s.settings)
      if (n.success) setNotifications(n.data)
      if (rw.pending) setRetentionWarning(rw)
      if (usage?.success) setApiUsage(usage)
    }).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const set = (key, value) => setSettings(s => ({ ...s, [key]: value }))

  const requestSave = () => setConfirmOpen(true)

  const confirmSave = async () => {
    setConfirmOpen(false)
    setSaving(true); setSaved(false)
    try {
      const res = await authFetch('/api/admin/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(settings) })
      const data = await res.json()
      if (data.success) { setSaved(true); setTimeout(()=>setSaved(false), 2500) }
    } finally { setSaving(false) }
  }

  const retryQueue = async () => {
    await authFetch('/api/notifications/retry', { method:'POST' })
    load()
  }

  const acknowledgeRetentionWarning = async () => {
    await authFetch('/api/admin/retention-warning?ack=1')
    setRetentionWarning(null)
  }

  const inp = { width:'100%', border:'1.5px solid #e5e7eb', borderRadius:10, padding:'10px 14px', fontSize:14, outline:'none', boxSizing:'border-box', backgroundColor:'white' }
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  if (loading) return <AdminLayout><div style={{ textAlign:'center', padding:48, color:'#9ca3af' }}>Loading settings…</div></AdminLayout>

  return (
    <AdminLayout>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:24, fontWeight:800, color:'#1a0820', margin:0 }}>System Settings</h1>
        <p style={{ color:'#766D82', fontSize:14, marginTop:4 }}>Configure OCR, tracking, retention, and notifications</p>
      </div>

      {/* Retention backup warning — in-app popup banner, not a browser alert */}
      {retentionWarning && (
        <div style={{ backgroundColor:'#fffbeb', border:'1.5px solid #fcd34d', borderRadius:16, padding:'16px 20px', marginBottom:20, display:'flex', alignItems:'flex-start', gap:14 }}>
          <FaTriangleExclamation size={18} color="#d97706" style={{ marginTop:2, flexShrink:0 }} />
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:800, color:'#92400e', fontSize:14 }}>Backup warning</div>
            <div style={{ fontSize:13, color:'#92400e', marginTop:4 }}>
              {retentionWarning.count} shipment{retentionWarning.count===1?'':'s'} will reach the retention limit and be backed up + removed from the live system within the next {settings.retention_warning_days || 30} days.
            </div>
          </div>
          <button onClick={acknowledgeRetentionWarning}
            style={{ padding:'7px 14px', borderRadius:10, border:'1.5px solid #d97706', backgroundColor:'white', color:'#92400e', fontSize:12, fontWeight:700, cursor:'pointer', flexShrink:0 }}>
            Got it
          </button>
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }} className="settings-grid">
        <SectionCard title="AWB Extraction Engine">
          <Field label="Primary OCR Engine" hint="Falls back to Tesseract automatically if Google Vision is unconfigured or fails.">
            <select value={settings.ocr_engine_primary||'google_vision'} onChange={e=>set('ocr_engine_primary', e.target.value)} style={inp}>
              <option value="google_vision">Google Vision (recommended)</option>
              <option value="tesseract">Tesseract (offline, no API key needed)</option>
            </select>
          </Field>

          <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', marginBottom:16, marginTop:24 }}>Security Policy</h2>
          <Field label="Password Expiry (days)">
            <input type="number" value={settings.password_expiry_days||90} onChange={e=>set('password_expiry_days', e.target.value)} style={inp} />
          </Field>
          <Field label="Session Timeout (minutes)">
            <input type="number" value={settings.session_timeout_minutes||30} onChange={e=>set('session_timeout_minutes', e.target.value)} style={inp} />
          </Field>
          <Field label="Audit Log Retention (days)" hint="Older audit entries are purged automatically by the Audit Retention worker.">
            <input type="number" value={settings.audit_retention_days||365} onChange={e=>set('audit_retention_days', e.target.value)} style={inp} />
          </Field>
        </SectionCard>

        {/* Tracking — register-once + webhook model. There is no schedule to
            configure: a shipment is registered with a provider a single time
            at creation, and TrackingMore/17Track push status updates to our
            webhook endpoints from then on — no polling, no cycles, no
            per-shipment interval. */}
        <SectionCard title="Tracking (TrackingMore / 17Track)" icon={<FaSatelliteDish size={13} color="#7B3FAD" />}>
          <div style={{ fontSize:12, color:'#565062', lineHeight:1.6, marginBottom:16, padding:'12px 14px', borderRadius:12, backgroundColor:'#faf5ff' }}>
            Each shipment is registered with a provider <strong>once</strong>, right when it's created. From then on
            TrackingMore/17Track track it on their own and push status changes to the webhook URLs below — there's
            nothing to schedule here.
          </div>

          <div style={{ display:'flex', gap:10, marginBottom:20 }}>
            {[
              ['TrackingMore', apiUsage?.trackingmore],
              ['17Track', apiUsage?.seventeentrack],
            ].map(([name, data]) => (
              <span key={name} style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11, fontWeight:700, padding:'4px 10px', borderRadius:50, backgroundColor: data?.configured ? '#d1fae5' : '#fef2f2', color: data?.configured ? '#065f46' : '#dc2626' }}>
                <FaCircleDot size={6} /> {name} {data?.configured ? 'configured' : 'not configured'}
              </span>
            ))}
          </div>

          <Field label="Webhook URL — TrackingMore" hint="Paste this into TrackingMore's dashboard: Settings → Webhook.">
            <CopyableUrl url={`${origin}/api/webhooks/trackingmore`} />
          </Field>
          <Field label="Webhook URL — 17Track" hint="Paste this into 17Track's dashboard: Settings → Webhook (https://api.17track.net/admin/settings).">
            <CopyableUrl url={`${origin}/api/webhooks/17track`} />
          </Field>
        </SectionCard>

        {/* Retention & Backup */}
        <SectionCard title="Data Retention & Backup" icon={<FaBoxArchive size={13} color="#7B3FAD" />}>
          <Field label="Retention Period — Delivered Shipments (months)" hint="Shipments still in transit (not Delivered) are kept indefinitely regardless of this setting.">
            <input type="number" min="1" value={settings.retention_months||6} onChange={e=>set('retention_months', e.target.value)} style={inp} />
          </Field>
          <Field label="Backup Warning — Days Before Purge" hint="You'll get a popup + notification this many days before delivered shipments are backed up and removed.">
            <input type="number" min="1" value={settings.retention_warning_days||30} onChange={e=>set('retention_warning_days', e.target.value)} style={inp} />
          </Field>
          <Field label="Lag Status Threshold (days)" hint="A shipment stuck on the same status this many days (and not Delivered) is flagged as Lag Status and included in the Lag Status report.">
            <input type="number" min="1" value={settings.lag_status_days||7} onChange={e=>set('lag_status_days', e.target.value)} style={inp} />
          </Field>
        </SectionCard>

        <SectionCard title="Notifications" icon={<FaBell size={13} color="#7B3FAD" />}>
          <Field label="Email Notifications" hint="Requires SMTP_HOST etc. to be set in the backend .env file.">
            <select value={settings.notifications_email_enabled||'0'} onChange={e=>set('notifications_email_enabled', e.target.value)} style={inp}>
              <option value="1">Enabled</option>
              <option value="0">Disabled</option>
            </select>
          </Field>
          <Field label="WhatsApp Notifications" hint="Requires WhatsApp Business API credentials in the backend .env file.">
            <select value={settings.notifications_whatsapp_enabled||'0'} onChange={e=>set('notifications_whatsapp_enabled', e.target.value)} style={inp}>
              <option value="1">Enabled</option>
              <option value="0">Disabled</option>
            </select>
          </Field>
          <Field label="Super Admin Email Recipients" hint="Comma-separated. Receives Lag Status reports and retention/backup warnings.">
            <input value={settings.notify_email_recipients||''} onChange={e=>set('notify_email_recipients', e.target.value)} placeholder="admin@company.com, ops@company.com" style={inp} />
          </Field>
          <Field label="Super Admin WhatsApp Recipients" hint="Comma-separated phone numbers, with country code (e.g. +9198xxxxxxx).">
            <input value={settings.notify_whatsapp_recipients||''} onChange={e=>set('notify_whatsapp_recipients', e.target.value)} placeholder="+9198xxxxxxx" style={inp} />
          </Field>
          <Field label="IT Alert Email" hint="Application errors and worker failures are emailed here directly, regardless of the Email Notifications toggle above.">
            <input value={settings.it_alert_email||''} onChange={e=>set('it_alert_email', e.target.value)} placeholder="it-support@company.com" style={inp} />
          </Field>

          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:24, marginBottom:12 }}>
            <h2 style={{ fontSize:14, fontWeight:700, color:'#1a0820', margin:0 }}>Recent Notification Queue</h2>
            <button onClick={retryQueue} style={{ fontSize:11, fontWeight:700, color:'#7B3FAD', background:'none', border:'1.5px solid #7B3FAD', borderRadius:8, padding:'5px 10px', cursor:'pointer', display:'inline-flex', alignItems:'center', gap:6 }}><FaArrowRotateRight size={11} /> Retry Failed</button>
          </div>
          {!notifications.length ? (
            <div style={{ color:'#9ca3af', fontSize:13 }}>No notifications yet.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8, maxHeight:220, overflowY:'auto' }}>
              {notifications.map(n => (
                <div key={n.id} style={{ display:'flex', justifyContent:'space-between', fontSize:12, padding:'6px 0', borderBottom:'1px solid #faf5ff' }}>
                  <span style={{ color:'#374151', display:'inline-flex', alignItems:'center', gap:6 }}>{n.event} <FaArrowRight size={9} /> {n.recipient || '—'}</span>
                  <span style={{ fontWeight:700, color: n.status==='Sent' ? '#059669' : n.status==='Failed' ? '#dc2626' : '#d97706' }}>{n.status}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div style={{ marginTop:24, display:'flex', alignItems:'center', gap:12 }}>
        <button onClick={requestSave} disabled={saving}
          style={{ padding:'12px 28px', background:'linear-gradient(135deg,#7B3FAD,#5B2D8B)', color:'white', border:'none', borderRadius:12, fontSize:14, fontWeight:700, cursor:saving?'not-allowed':'pointer', opacity:saving?0.7:1 }}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span style={{ color:'#059669', fontSize:13, fontWeight:700, display:'inline-flex', alignItems:'center', gap:6 }}><FaCheck size={11} /> Saved</span>}
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="Save settings changes?"
        message="This updates the live configuration — including retention policy and notification recipients — for everyone using the system."
        confirmLabel="Save Changes"
        onConfirm={confirmSave}
        onCancel={() => setConfirmOpen(false)}
      />

      <style>{`.settings-grid{grid-template-columns:1fr!important} @media(min-width:900px){.settings-grid{grid-template-columns:1fr 1fr!important}}`}</style>
    </AdminLayout>
  )
}