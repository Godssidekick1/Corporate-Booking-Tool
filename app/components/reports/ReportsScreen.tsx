'use client'

import { useEffect, useMemo, useState } from 'react'
import Tabs, { useUrlTab } from '@/app/components/Tabs'
import SearchableSelect from '@/app/components/SearchableSelect'
import { SkeletonTiles, SkeletonTable } from '@/app/components/Skeleton'
import { BarSeries, BarList, StackedSeries } from '@/app/components/charts/Bars'
import { useLookup, clientOption } from '@/app/hooks/useLookup'
import type { Report, ReportTable, ValueKind, Cell, FilterKey } from '@/app/lib/reports/types'
import type { CatalogEntry } from '@/app/lib/reports/catalog'

// ── Reports, either side ─────────────────────────────────────────────────────
// One tab per report in the side's catalog (app/lib/reports/catalog.ts),
// over one shared date range and filter bar: changing tab keeps the period.
// The index route (/api/reports or /api/tmc/reports) gives the filters'
// choices. Each report is drawn from its one shape (headline tiles,
// a chart, tables; app/lib/reports/types.ts), and every table downloads as
// the CSV of exactly what it shows.
// ─────────────────────────────────────────────────────────────────────────────

interface Option { value: string; label: string }
interface Index {
  options: { departments?: Option[]; costCentres?: Option[]; bands?: Option[]; clientGroups?: Option[] }
  range: { from: string; to: string }
}

type Preset = 'this-month' | 'last-month' | 'last-3' | 'fy' | 'year' | 'custom'
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'last-3', label: 'Last 3 months' },
  { id: 'fy', label: 'This financial year' },
  { id: 'year', label: 'This calendar year' },
  { id: 'custom', label: 'Custom dates' },
]

// India's today, and the first day of a month relative to it.
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
}
function monthStart(offset: number): string {
  const [y, m] = today().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 10)
}
function rangeFor(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const t = today()
  const [y, m] = t.split('-').map(Number)
  switch (p) {
    case 'this-month': return { from: monthStart(0), to: t }
    case 'last-month': return { from: monthStart(-1), to: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10) }
    case 'last-3': return { from: monthStart(-2), to: t }
    case 'fy': return { from: `${m >= 4 ? y : y - 1}-04-01`, to: t }
    case 'year': return { from: `${y}-01-01`, to: t }
  }
}

const FILTER_LABEL: Record<FilterKey, string> = {
  department: 'Department', costCentre: 'Cost centre', band: 'Band', billable: 'Billable',
  clientId: 'Client', clientGroupId: 'Client group',
}

// ── Formatting by value kind ─────────────────────────────────────────────────

const inr = (n: number, paise: boolean) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: paise ? 2 : 0 })}`

function show(v: Cell | undefined, kind: ValueKind, inTable = false): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string') {
    if (kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return new Date(`${v}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    }
    return v
  }
  switch (kind) {
    case 'money': return (v < 0 ? '−' : '') + inr(Math.abs(v), inTable)
    case 'percent': return `${v.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`
    case 'hours': return `${v.toLocaleString('en-IN', { maximumFractionDigits: 1 })} h`
    case 'days': return `${v.toLocaleString('en-IN', { maximumFractionDigits: 1 })} days`
    default: return v.toLocaleString('en-IN')
  }
}

// Short money for bar labels: ₹1.2L, ₹45k.
function compactInr(n: number): string {
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(1)}Cr`
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)}L`
  if (a >= 1e3) return `${sign}₹${Math.round(a / 1e3)}k`
  return `${sign}₹${Math.round(a)}`
}

const chartFormat = (kind: ValueKind) => (n: number) =>
  kind === 'money' ? compactInr(n) : kind === 'percent' ? `${n}%` : n.toLocaleString('en-IN')

// Legend names with a meaning keep their colour on every chart.
const PART_COLOUR: Record<string, string> = {
  'Within policy': '#16A34A', 'Needs approval': '#F59E0B', 'Out of policy': '#DC2626', 'Not checked': '#D1D5DB',
  Approved: '#16A34A', Rejected: '#DC2626',
  Company: '#000835', 'Agency (TMC)': '#7C3AED', Traveller: '#0EA5E9', 'Not recorded': '#D1D5DB',
}

// ── The screen ───────────────────────────────────────────────────────────────

export default function ReportsScreen({ base, catalog, title, intro }: {
  base: string
  catalog: readonly CatalogEntry[]
  title: string
  intro: string
}) {
  const [index, setIndex] = useState<Index | null>(null)
  const [indexError, setIndexError] = useState('')
  const [tab, setTab] = useUrlTab<string>('report', catalog[0].key, catalog.map(r => r.key))

  const [preset, setPreset] = useState<Preset>('last-3')
  const [range, setRange] = useState<{ from: string; to: string }>(() => rangeFor('last-3'))
  const [filters, setFilters] = useState<Partial<Record<FilterKey, string>>>({})

  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(base)
      .then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) { setIndexError(body.error ?? 'Reports could not be loaded.'); return }
        setIndex(body as Index)
      })
      .catch(() => setIndexError('Reports could not be loaded. Check your connection and try again.'))
  }, [base])

  const active = index ? catalog.find(r => r.key === tab) ?? catalog[0] : null

  // The query a report and its CSVs are fetched with: the dates and only the
  // filters this report understands.
  const query = useMemo(() => {
    const q = new URLSearchParams({ from: range.from, to: range.to })
    for (const k of active?.filters ?? []) if (filters[k]) q.set(k, filters[k] as string)
    return q.toString()
  }, [active, range, filters])

  useEffect(() => {
    if (!active) return
    let stale = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError('')
    fetch(`${base}/${active.key}?${query}`)
      .then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (stale) return
        if (!ok) { setError(body.error ?? 'This report could not be loaded.'); setReport(null); return }
        setReport(body.report as Report)
      })
      .catch(() => { if (!stale) setError('This report could not be loaded. Check your connection and try again.') })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [base, active, query])

  function choosePreset(p: Preset) {
    setPreset(p)
    if (p !== 'custom') setRange(rangeFor(p))
  }

  return (
    <main className="page-frame">
      <header style={s.header}>
        <h1 style={s.title}>{title}</h1>
        <p style={s.intro}>{intro}</p>
      </header>

      {indexError && <p style={s.errorBox} role="alert">{indexError}</p>}

      {index && active && (
        <>
          <div style={s.tabsWrap}>
            <Tabs tabs={catalog.map(r => ({ id: r.key, label: r.title }))} active={active.key} onChange={setTab} />
          </div>

          <FilterBar
            preset={preset} onPreset={choosePreset}
            range={range} onRange={r => { setPreset('custom'); setRange(r) }}
            keys={active.filters} options={index.options}
            values={filters} onChange={(k, v) => setFilters(f => ({ ...f, [k]: v }))}
          />

          {error && <p style={s.errorBox} role="alert">{error}</p>}
          {loading && !report && <><SkeletonTiles count={4} /><div style={{ height: 16 }} /><SkeletonTable rows={5} cols={5} /></>}
          {report && <ReportBody report={report} csvBase={`${base}/${report.key}?${query}`} dimmed={loading} />}
        </>
      )}
      {!index && !indexError && <><SkeletonTiles count={4} /><div style={{ height: 16 }} /><SkeletonTable rows={5} cols={5} /></>}
    </main>
  )
}

function FilterBar({ preset, onPreset, range, onRange, keys, options, values, onChange }: {
  preset: Preset
  onPreset: (p: Preset) => void
  range: { from: string; to: string }
  onRange: (r: { from: string; to: string }) => void
  keys: readonly FilterKey[]
  options: Index['options']
  values: Partial<Record<FilterKey, string>>
  onChange: (k: FilterKey, v: string) => void
}) {
  const clientLookup = useLookup('/api/tmc/clients', values.clientId ?? '', {
    toOption: clientOption, enabled: keys.includes('clientId'),
  })
  const listFor: Partial<Record<FilterKey, Option[] | undefined>> = {
    department: options.departments, costCentre: options.costCentres, band: options.bands,
    clientGroupId: options.clientGroups,
    billable: [{ value: 'yes', label: 'Billable' }, { value: 'no', label: 'Not billable' }],
  }

  return (
    <section style={s.filters} aria-label="Report filters">
      <label style={s.field}>
        <span style={s.fieldLabel}>Period</span>
        <select style={s.input} value={preset} onChange={e => onPreset(e.target.value as Preset)}>
          {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label style={s.field}>
        <span style={s.fieldLabel}>From</span>
        <input type="date" style={s.input} value={range.from} max={range.to}
          onChange={e => e.target.value && onRange({ ...range, from: e.target.value })} />
      </label>
      <label style={s.field}>
        <span style={s.fieldLabel}>To</span>
        <input type="date" style={s.input} value={range.to} min={range.from}
          onChange={e => e.target.value && onRange({ ...range, to: e.target.value })} />
      </label>

      {keys.map(k => k === 'clientId' ? (
        <div key={k} style={{ ...s.field, minWidth: 240, flex: '1 1 240px' }}>
          <span style={s.fieldLabel}>{FILTER_LABEL[k]}</span>
          <SearchableSelect
            value={values.clientId ?? ''} onChange={id => onChange('clientId', id)}
            options={clientLookup.options} onSearch={clientLookup.onSearch} loading={clientLookup.loading}
            selectedLabel={clientLookup.selectedLabel}
            placeholder="All clients" emptyMessage="No clients match" allowClear clearLabel="All clients"
          />
        </div>
      ) : (
        <label key={k} style={s.field}>
          <span style={s.fieldLabel}>{FILTER_LABEL[k]}</span>
          <select style={s.input} value={values[k] ?? ''} onChange={e => onChange(k, e.target.value)}>
            <option value="">All</option>
            {(listFor[k] ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      ))}
    </section>
  )
}

export function ReportBody({ report, csvBase, dimmed }: { report: Report; csvBase: string; dimmed: boolean }) {
  const chart = report.chart
  const format = chart ? chartFormat(chart.valueKind) : String
  const hasData = chart?.points.some(p => p.value !== 0) ?? false
  return (
    <div style={{ opacity: dimmed ? 0.55 : 1, transition: 'opacity 120ms' }} aria-busy={dimmed}>
      <p style={s.description}>{report.description}</p>

      <div style={s.tiles}>
        {report.headline.map(t => (
          <div key={t.label} style={s.tile}>
            <p style={s.tileLabel}>{t.label}</p>
            <p style={{ ...s.tileValue, ...(t.kind === 'text' ? s.tileText : {}) }} title={typeof t.value === 'string' ? t.value : undefined}>
              {show(t.value, t.kind)}
            </p>
            {t.hint && <p style={s.tileHint}>{t.hint}</p>}
          </div>
        ))}
      </div>

      {chart && (
        <section style={s.card}>
          <h2 style={s.cardTitle}>{chart.title}</h2>
          {!hasData ? <p style={s.empty}>Nothing to chart in this period.</p>
            : chart.kind === 'list' ? <BarList items={chart.points} format={format} />
            : chart.legend ? (
              <StackedSeries
                points={chart.points.map(p => ({ ...p, parts: p.parts ?? [p.value] }))}
                legend={chart.legend} format={format}
                colors={chart.legend.map((name, i) => PART_COLOUR[name] ?? ['#000835', '#7C3AED', '#0EA5E9', '#D1D5DB'][i % 4])}
              />
            ) : <BarSeries points={chart.points} format={format} />}
        </section>
      )}

      {report.tables.map(t => <TableCard key={t.key} table={t} csvHref={`${csvBase}&format=csv&table=${t.key}`} />)}
    </div>
  )
}

const SHOWN = 25

function TableCard({ table, csvHref }: { table: ReportTable; csvHref: string }) {
  const [all, setAll] = useState(false)
  const rows = all ? table.rows : table.rows.slice(0, SHOWN)
  const numeric = (k: ValueKind) => k !== 'text' && k !== 'date'
  return (
    <section style={s.card}>
      <div style={s.cardHead}>
        <h2 style={s.cardTitle}>{table.title}</h2>
        {table.rows.length > 0 && <a href={csvHref} style={s.csvBtn} download>Download CSV</a>}
      </div>
      {table.rows.length === 0 ? <p style={s.empty}>Nothing in this period.</p> : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>{table.columns.map(c => (
                <th key={c.key} style={{ ...s.th, textAlign: numeric(c.kind) ? 'right' : 'left' }}>{c.label}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {table.columns.map((c, j) => (
                    <td key={c.key} style={{
                      ...s.td, textAlign: numeric(c.kind) ? 'right' : 'left',
                      ...(j === 0 ? s.tdFirst : {}),
                      ...(c.kind === 'money' && typeof r[c.key] === 'number' && (r[c.key] as number) < 0 ? s.negative : {}),
                    }}>{show(r[c.key], c.kind, true)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(table.note || table.rows.length > SHOWN) && (
        <div style={s.tableFoot}>
          {table.note && <span>{table.note}</span>}
          {table.rows.length > SHOWN && (
            <button type="button" style={s.linkBtn} onClick={() => setAll(v => !v)}>
              {all ? `Show the first ${SHOWN}` : `Show all ${table.rows.length.toLocaleString('en-IN')} rows`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

const s: Record<string, React.CSSProperties> = {
  header: { marginBottom: 20 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  intro: { fontSize: 13, color: '#6B7280', margin: 0, maxWidth: 720, lineHeight: 1.55 },
  tabsWrap: { overflowX: 'auto' },

  filters: {
    display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', background: '#fff',
    border: '1px solid #E5E7EB', borderRadius: 10, padding: '12px 14px', marginBottom: 18,
  },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150, flex: '0 1 180px' },
  fieldLabel: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px' },
  input: {
    height: 36, border: '1px solid #D1D5DB', borderRadius: 7, padding: '0 10px', fontSize: 13,
    color: '#111827', background: '#fff', width: '100%', boxSizing: 'border-box',
  },

  description: { fontSize: 13, color: '#4B5563', margin: '0 0 14px', lineHeight: 1.55, maxWidth: 820 },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 16 },
  tile: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 9, padding: '14px 16px', minWidth: 0 },
  tileLabel: { fontSize: 10.5, fontWeight: 600, color: '#9CA3AF', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.4px' },
  tileValue: { fontSize: 22, fontWeight: 700, color: '#111827', margin: 0, fontVariantNumeric: 'tabular-nums' },
  tileText: { fontSize: 16, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tileHint: { fontSize: 11, color: '#9CA3AF', margin: '4px 0 0', lineHeight: 1.4 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 9, padding: 18, marginBottom: 16 },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
  cardTitle: { fontSize: 13, fontWeight: 600, color: '#111827', margin: '0 0 12px' },
  csvBtn: {
    fontSize: 12, fontWeight: 600, color: '#000835', textDecoration: 'none', border: '1px solid #D1D5DB',
    borderRadius: 7, padding: '6px 11px', background: '#fff', whiteSpace: 'nowrap',
  },
  empty: { fontSize: 12.5, color: '#9CA3AF', margin: '4px 0' },
  tableWrap: { overflowX: 'auto', margin: '0 -18px', padding: '0 18px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' },
  th: {
    fontSize: 11, fontWeight: 600, color: '#6B7280', padding: '8px 10px', borderBottom: '1px solid #E5E7EB',
    whiteSpace: 'nowrap', background: '#F9FAFB',
  },
  td: { padding: '9px 10px', borderBottom: '1px solid #F3F4F6', color: '#374151', whiteSpace: 'nowrap' },
  tdFirst: { color: '#111827', fontWeight: 500 },
  negative: { color: '#B91C1C' },
  tableFoot: { display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: '#9CA3AF', marginTop: 10 },
  linkBtn: { background: 'none', border: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: '#000835', cursor: 'pointer' },
  errorBox: {
    fontSize: 13, color: '#991B1B', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8,
    padding: '10px 12px', margin: '0 0 16px',
  },
}
