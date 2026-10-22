import type { ReportTable, Cell } from './types'

// ── A report table as CSV ────────────────────────────────────────────────────
// The same columns and rows as on screen, values unformatted (a spreadsheet
// sums 12500.5, not "₹12,500.50"). Text a person typed (a name, a project)
// that begins with = + - @ is prefixed with an apostrophe, so a spreadsheet
// shows it rather than running it as a formula. Numbers are never touched.
// ─────────────────────────────────────────────────────────────────────────────

function cell(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function tableCsv(table: ReportTable): string {
  const head = table.columns.map(c => cell(c.label)).join(',')
  const rows = table.rows.map(r => table.columns.map(c => cell(r[c.key] ?? null)).join(','))
  return [head, ...rows].join('\r\n')
}

export function csvResponse(table: ReportTable, name: string): Response {
  const safe = name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
  // The BOM makes Excel read the file as UTF-8 (₹, names with accents).
  return new Response(`﻿${tableCsv(table)}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe}.csv"`,
    },
  })
}
