// src/utils/waybillDownload.js — shared helpers for triggering a waybill PDF
// download from the browser. The backend never stores these files — it
// streams them straight from a temp file and deletes it right after (see
// routes/shipments.js generate-waybill / waybills/bulk-download) — so all a
// caller needs to do is fire the request and save the blob it gets back.

/** Pulls the filename the backend chose out of a Content-Disposition header. */
function filenameFromHeader(res, fallback) {
  const cd = res.headers.get('content-disposition') || ''
  const match = cd.match(/filename="?([^"]+)"?/i)
  return match ? match[1] : fallback
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

/**
 * Generates + downloads a single shipment's Garuda Waybill PDF.
 * @param {function} authFetch
 * @param {number|string} shipmentId
 * @param {string} [fallbackName] used only if the server didn't send a filename
 */
export async function downloadWaybill(authFetch, shipmentId, fallbackName = 'GarudaWaybill.pdf') {
  const res = await authFetch(`/api/shipments/${shipmentId}/generate-waybill`, { method: 'POST' })
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'Generation failed' }))
    throw new Error(e.error || 'Waybill generation failed')
  }
  const blob = await res.blob()
  saveBlob(blob, filenameFromHeader(res, fallbackName))
}

/**
 * Generates + downloads a ZIP of multiple shipments' waybills in one request.
 * @param {function} authFetch
 * @param {(number|string)[]} shipmentIds
 */
export async function downloadWaybillsZip(authFetch, shipmentIds) {
  const res = await authFetch('/api/shipments/waybills/bulk-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: shipmentIds }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'Generation failed' }))
    throw new Error(e.error || 'Bulk waybill generation failed')
  }
  const blob = await res.blob()
  saveBlob(blob, filenameFromHeader(res, `Garuda_Waybills_${Date.now()}.zip`))
}

/**
 * Confirms with the user, then generates + downloads — used right after
 * creating shipment(s) via single entry, bulk PDF/CSV/ZIP upload, or Excel
 * vendor import, per the "Generate Waybill?" prompt requirement.
 *
 * `confirmFn` should be a promise-returning `(opts) => Promise<boolean>` —
 * pass the `confirm` function from ../hooks/useConfirm.js so the prompt
 * renders through the app's own <ConfirmModal> rather than a native
 * window.confirm() popup. Falls back to window.confirm() if no confirmFn is
 * given, so this still works from anywhere that hasn't wired up the hook.
 *
 * @param {function} authFetch
 * @param {(number|string)[]} shipmentIds
 * @param {function} [confirmFn]
 * @returns {Promise<boolean>} whether the user confirmed (and generation was attempted)
 */
export async function confirmAndDownloadWaybills(authFetch, shipmentIds, confirmFn) {
  if (!shipmentIds?.length) return false
  const many = shipmentIds.length > 1
  const message = many ? `Generate Waybill for ${shipmentIds.length} shipments?` : 'Generate Waybill?'

  const ok = confirmFn
    ? await confirmFn({ title: 'Generate Waybill?', message })
    : window.confirm(message)
  if (!ok) return false

  if (many) await downloadWaybillsZip(authFetch, shipmentIds)
  else await downloadWaybill(authFetch, shipmentIds[0])
  return true
}