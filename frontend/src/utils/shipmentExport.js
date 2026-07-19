// src/utils/shipmentExport.js — the two export modes offered from the
// Shipments page's "Export XLSX" button.
//
//  - exportVisibleShipments: builds the .xlsx entirely in the browser from
//    the exact rows/columns already rendered in the table (current page,
//    current filters/sort) — no backend round-trip, so it can never drift
//    from what's actually on screen.
//  - exportFullShipments: asks the backend for every shipment matching the
//    current filter bar (all pages, not just the one you're looking at)
//    with every field on the shipment record.
import * as XLSX from 'xlsx'

function triggerDownload(blob, filename) {
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

/**
 * "Visible Content" — exactly what's showing in the table right now: the
 * same rows (this page only) and the same columns (GE #, From, To, Carrier,
 * Weight/Pieces, Status, Date) as the on-screen table.
 * @param {object[]} shipments - the same array the table is currently rendering
 */
export function exportVisibleShipments(shipments) {
  const rows = shipments.map(s => ({
    'GE Number': s.ge_tracking_number,
    'From Name': s.from_name || '',
    'From City': s.from_city || '',
    'From Country': s.from_country || '',
    'To Name': s.to_name || '',
    'To City': s.to_city || '',
    'To Country': s.to_country || '',
    'Carrier': s.carrier || '',
    'Weight (kg)': s.billing_weight || s.actual_weight || '',
    'Pieces': s.pieces || 1,
    'Status': s.status || '',
    'Date': s.ship_date || (s.created_at ? String(s.created_at).slice(0, 10) : ''),
  }))

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: 'No shipments on this page' }]), 'Shipments')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `GarudaExpress_VisiblePage_${Date.now()}.xlsx`)
}

/**
 * "Full Content" — every shipment matching the current filter bar (all
 * pages), every field, fetched from the backend.
 * @param {function} authFetch
 * @param {{ q?, status?, carrier?, dateFrom?, dateTo? }} filters
 */
export async function exportFullShipments(authFetch, filters = {}) {
  const params = new URLSearchParams()
  if (filters.q)        params.set('q', filters.q)
  if (filters.status)   params.set('status', filters.status)
  if (filters.carrier)  params.set('carrier', filters.carrier)
  if (filters.dateFrom) params.set('date_from', filters.dateFrom)
  if (filters.dateTo)   params.set('date_to', filters.dateTo)

  const res = await authFetch(`/api/shipments/export/xlsx?${params}`)
  if (!res.ok) {
    let msg = `Export failed (${res.status})`
    try { const data = await res.json(); if (data?.error) msg = data.error } catch { /* non-JSON error body */ }
    throw new Error(msg)
  }
  const blob = await res.blob()
  triggerDownload(blob, `GarudaExpress_FullExport_${Date.now()}.xlsx`)
}