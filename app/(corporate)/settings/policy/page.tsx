'use client'

import { useEffect, useState } from 'react'
import { CATEGORIES, formatFieldValue } from '@/app/lib/policy/fields'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Band {
  code: string
  label: string
  rank: number
}

interface PolicyGroupSummary {
  id: string
  name: string
  code: string | null
  bandRanks: number[]
  version: number
}

interface EffectiveRow {
  band_code: string
  band_rank: number
  travel_type: string
  limit_key: string
  limit_value: number | null
  limit_bool: boolean | null
  policy_group_id: string
  group_name: string
}

interface UnresolvedBand {
  band_code: string
  band_label: string
  band_rank: number
  reason: 'no_policy_group' | 'overlapping_policy_groups' | 'no_policy_rules'
  detail: string
}

type CellVal = number | boolean | null
type Grid = Record<string, Record<string, CellVal>>

function rowsToGrid(rows: EffectiveRow[]): Grid {
  const grid: Grid = {}
  for (const row of rows) {
    if (!grid[row.band_code]) grid[row.band_code] = {}
    grid[row.band_code][row.limit_key] = row.limit_value ?? row.limit_bool ?? null
  }
  return grid
}

// Collapses runs back into ranges so [1,2,3,7] reads "ranks 1–3, 7".
function ranksLabel(bandRanks: number[]): string {
  if (bandRanks.length === 0) return 'no ranks'

  const parts: string[] = []
  let runStart = bandRanks[0]
  let previous = bandRanks[0]

  for (let i = 1; i <= bandRanks.length; i++) {
    const current = bandRanks[i]
    if (current === previous + 1) { previous = current; continue }

    if (runStart === previous) parts.push(String(runStart))
    else if (previous === runStart + 1) parts.push(`${runStart}, ${previous}`)
    else parts.push(`${runStart}–${previous}`)

    runStart = current
    previous = current
  }

  return `${bandRanks.length === 1 ? 'rank' : 'ranks'} ${parts.join(', ')}`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SettingsPolicyPage() {
  const [bands, setBands] = useState<Band[]>([])
  const [groups, setGroups] = useState<PolicyGroupSummary[]>([])
  const [grid, setGrid] = useState<Grid>({})
  const [groupByBand, setGroupByBand] = useState<Record<string, string>>({})
  const [unresolved, setUnresolved] = useState<UnresolvedBand[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    async function loadPolicy() {
      setLoading(true)
      setError('')
      try {
        const res = await fetch('/api/settings/policy')
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) { setError(data.error || 'Failed to load policy'); return }

        setBands(data.bands)
        setGroups(data.groups)
        setGrid(rowsToGrid(data.rows))
        setUnresolved(data.unresolved)
        setGroupByBand(
          Object.fromEntries(
            (data.rows as EffectiveRow[]).map(r => [r.band_code, r.group_name])
          )
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadPolicy()
    return () => { cancelled = true }
  }, [])

  // Only render bands that actually resolved to a policy — an unresolved band
  // gets a line in the notice below instead of a row of dashes that looks like
  // a policy of "no limits".
  const resolvedBands = bands.filter(b => grid[b.code])

  return (
    <div style={s.root}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.pageTitle}>Travel Policy</h1>
          <p style={s.pageSub}>
            Managed by your TMC. Contact them to request a change.
          </p>
        </div>
        {groups.length > 0 && (
          <div style={s.headerRight}>
            {groups.map(g => (
              <span key={g.id} style={s.groupChip}>
                {g.name}
                <span style={s.groupChipMeta}>
                  {ranksLabel(g.bandRanks)}{g.version > 0 ? ` · v${g.version}` : ''}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {/* Distinct from "no policy linked": without bands there is nothing for a
          rank range to match, so the fix is to configure bands, not to chase
          the TMC for a policy group. */}
      {!loading && bands.length === 0 && (
        <div style={s.infoBanner}>
          <strong>No employee bands are configured for your company.</strong>
          {' '}Travel policy applies per band, so nothing can take effect until
          bands exist. Ask your TMC to set them up.
        </div>
      )}

      {!loading && bands.length > 0 && unresolved.length > 0 && (
        <div style={s.infoBanner}>
          <strong>
            {unresolved.length === bands.length
              ? 'No travel policy is in force yet.'
              : `${unresolved.length} of your ${bands.length} bands have no policy in force.`}
          </strong>
          <ul style={s.unresolvedList}>
            {unresolved.map(u => (
              <li key={u.band_code}>
                <strong>{u.band_code}</strong> ({u.band_label}) — {u.detail}
              </li>
            ))}
          </ul>
          Employees in these bands will not have their bookings checked against a
          policy. Ask your TMC to link a policy group covering them.
        </div>
      )}

      {loading ? (
        <div style={s.loadingWrap}>
          <p style={s.loadingText}>Loading policy…</p>
        </div>
      ) : resolvedBands.length === 0 ? null : (
        <div style={s.tables}>
          {CATEGORIES.map(cat => (
            <div key={cat.id} style={s.tableSection}>
              <div style={{ ...s.tableSectionHeader, background: cat.color }}>
                <span style={{ ...s.tableSectionTitle, color: cat.textColor }}>{cat.label}</span>
              </div>
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={{ ...s.th, ...s.stickyCol, width: 170 }}>Band</th>
                      {cat.fields.map(f => (
                        <th key={f.key} style={s.th}>
                          <span style={s.colLabel}>{f.label}</span>
                          {f.unit && <span style={s.colUnit}> · {f.unit}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {resolvedBands.map((band, ri) => (
                      <tr key={band.code} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                        <td style={{ ...s.td, ...s.stickyCol }}>
                          <div style={s.bandCell}>
                            <span style={s.bandBadge}>{band.code}</span>
                            <span style={s.bandLabel}>{band.label}</span>
                            {groupByBand[band.code] && (
                              <span style={s.bandGroup}>{groupByBand[band.code]}</span>
                            )}
                          </div>
                        </td>
                        {cat.fields.map(f => (
                          <td key={f.key} style={s.td}>
                            <span style={s.cellValue}>
                              {formatFieldValue(f, grid[band.code]?.[f.key])}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      <p style={s.footNote}>
        Travel policy is configured by your TMC and applies to everyone in the
        matching band. A dash (—) means no limit is set for that field.
      </p>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', gap: '16px' },
  pageTitle: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  pageSub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  headerRight: { display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' },
  groupChip: { display: 'inline-flex', flexDirection: 'column', gap: '1px', padding: '5px 11px', background: '#F5F7FF', border: '1px solid #E0E7FF', borderRadius: '7px', fontSize: '12px', fontWeight: 600, color: '#000835' },
  groupChipMeta: { fontSize: '10px', fontWeight: 400, color: '#6B7280' },
  infoBanner: { marginBottom: '16px', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: '#92400E', lineHeight: '1.6' },
  unresolvedList: { margin: '6px 0', paddingLeft: '18px' },
  errorBanner: { marginBottom: '16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#DC2626' },
  loadingWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px' },
  loadingText: { fontSize: '13px', color: '#9CA3AF' },
  tables: { display: 'flex', flexDirection: 'column', gap: '20px' },
  tableSection: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflow: 'hidden' },
  tableSectionHeader: { padding: '10px 16px', borderBottom: '1px solid #E5E7EB' },
  tableSectionTitle: { fontSize: '12px', fontWeight: 600, letterSpacing: '0.3px' },
  tableWrap: { overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%', minWidth: '500px' },
  th: { padding: '8px 12px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap', verticalAlign: 'top' },
  colLabel: { display: 'block', fontSize: '11px', fontWeight: 600, color: '#374151' },
  colUnit: { fontSize: '10px', color: '#9CA3AF', fontWeight: 400 },
  stickyCol: { position: 'sticky', left: 0, zIndex: 1, background: '#F9FAFB', borderRight: '1px solid #E5E7EB' },
  td: { padding: '8px 12px', borderBottom: '1px solid #F3F4F6', verticalAlign: 'middle' },
  bandCell: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' },
  bandBadge: { display: 'inline-block', padding: '2px 6px', background: '#EEF2FF', color: '#3730A3', fontSize: '10px', fontWeight: 700, borderRadius: '4px' },
  bandLabel: { fontSize: '12px', color: '#374151', fontWeight: 500 },
  bandGroup: { fontSize: '10px', color: '#9CA3AF' },
  cellValue: { fontSize: '12px', color: '#111827' },
  footNote: { fontSize: '11px', color: '#9CA3AF', lineHeight: '1.6', margin: '20px 0 0' },
}
