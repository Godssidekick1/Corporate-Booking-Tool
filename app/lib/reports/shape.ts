import type { ChartPoint, Column, ValueKind } from './types'

// ── Small shaping helpers shared by the report builders ──────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "2026-08-01" -> "Aug ’26": short enough for a bar's label.
export function monthLabel(day: string): string {
  const [y, m] = day.split('-').map(Number)
  return `${MONTHS[m - 1]} ’${String(y % 100).padStart(2, '0')}`
}

// A share as a percentage with one decimal; null when there is nothing to
// divide by, so the screen says "—" rather than 0%.
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null
}

export const round2 = (n: number) => Math.round(n * 100) / 100

export function series(rows: { month: string }[], value: (r: Record<string, unknown>) => number): ChartPoint[] {
  return rows.map(r => ({ label: monthLabel(r.month), value: round2(value(r as Record<string, unknown>)) }))
}

export function stacked(rows: { month: string }[], parts: ((r: Record<string, unknown>) => number)[]): ChartPoint[] {
  return rows.map(r => {
    const values = parts.map(p => p(r as Record<string, unknown>))
    return { label: monthLabel(r.month), value: values.reduce((a, b) => a + b, 0), parts: values }
  })
}

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const col = (key: string, label: string, kind: ValueKind): Column => ({ key, label, kind })

export function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`
