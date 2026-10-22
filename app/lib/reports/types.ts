// ── One shape for every report ───────────────────────────────────────────────
// A report is headline tiles, at most one chart, and one or more tables. The
// screen draws exactly this (app/components/reports/ReportView.tsx) and a
// table's CSV is that table, column for column, so what is downloaded is what
// was on screen. Values stay numbers here; the screen and the CSV format them
// by the column's kind, so a spreadsheet gets 12500.5 and not "₹12,500.50".
// ─────────────────────────────────────────────────────────────────────────────

export type ValueKind = 'money' | 'count' | 'percent' | 'hours' | 'days' | 'text' | 'date'

export interface Tile {
  label: string
  value: number | string | null
  kind: ValueKind
  // One line under the value: what it is measured against, or why it is empty.
  hint?: string
}

export interface ChartPoint {
  label: string
  value: number
  // A stacked chart's parts, in legend order; value is then their sum.
  parts?: number[]
}

export interface ReportChart {
  title: string
  kind: 'series' | 'list'
  valueKind: ValueKind
  points: ChartPoint[]
  // For a stacked series: the name of each part, matching ChartPoint.parts.
  legend?: string[]
}

export interface Column {
  key: string
  label: string
  kind: ValueKind
}

export type Cell = number | string | null

export interface ReportTable {
  key: string
  title: string
  columns: Column[]
  rows: Record<string, Cell>[]
  // Shown under the table: what is counted, or a row cap.
  note?: string
}

export interface Report {
  key: string
  title: string
  description: string
  headline: Tile[]
  chart: ReportChart | null
  tables: ReportTable[]
}

// The filters a report understands, all optional but the dates. Dates are
// India's calendar days, inclusive at both ends (YYYY-MM-DD).
export interface ReportFilters {
  from: string
  to: string
  department?: string
  costCentre?: string
  band?: string
  billable?: 'yes' | 'no'
  clientId?: string
  clientGroupId?: string
}

export type FilterKey = Exclude<keyof ReportFilters, 'from' | 'to'>
