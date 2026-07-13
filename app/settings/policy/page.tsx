'use client'

import { useEffect, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PolicyRow {
  band: string
  travel_type: string
  limit_key: string
  limit_value: number
  locked: boolean
}

interface PolicyGroup {
  id: string
  name: string
  description: string | null
}

const BAND_CODES = ['L1', 'L2', 'L3', 'L4', 'L5']

const BAND_LABELS: Record<string, string> = {
  L1: 'Junior', L2: 'Associate', L3: 'Senior', L4: 'Manager', L5: 'Director',
}

type LimitKey =
  | 'max_fare_domestic' | 'max_fare_intl'
  | 'cabin_class_short' | 'cabin_class_long'
  | 'advance_booking_days'
  | 'max_rate_major_city' | 'max_rate_other_city' | 'max_hotel_stars'
  | 'max_car_rate_per_day'
  | 'auto_approve_under' | 'finance_approval_over'

const DEFAULTS: Record<string, Record<LimitKey, number>> = {
  L1: { max_fare_domestic: 6000,  max_fare_intl: 50000,  cabin_class_short: 0, cabin_class_long: 0, advance_booking_days: 7, max_rate_major_city: 4000,  max_rate_other_city: 3000,  max_hotel_stars: 3, max_car_rate_per_day: 50,  auto_approve_under: 25000,  finance_approval_over: 75000  },
  L2: { max_fare_domestic: 8000,  max_fare_intl: 75000,  cabin_class_short: 0, cabin_class_long: 0, advance_booking_days: 7, max_rate_major_city: 6500,  max_rate_other_city: 5000,  max_hotel_stars: 3, max_car_rate_per_day: 60,  auto_approve_under: 40000,  finance_approval_over: 100000 },
  L3: { max_fare_domestic: 12000, max_fare_intl: 125000, cabin_class_short: 0, cabin_class_long: 0, advance_booking_days: 5, max_rate_major_city: 9000,  max_rate_other_city: 7500,  max_hotel_stars: 4, max_car_rate_per_day: 80,  auto_approve_under: 75000,  finance_approval_over: 200000 },
  L4: { max_fare_domestic: 16000, max_fare_intl: 200000, cabin_class_short: 0, cabin_class_long: 1, advance_booking_days: 3, max_rate_major_city: 15000, max_rate_other_city: 12500, max_hotel_stars: 5, max_car_rate_per_day: 100, auto_approve_under: 100000, finance_approval_over: 350000 },
  L5: { max_fare_domestic: 20000, max_fare_intl: 500000, cabin_class_short: 1, cabin_class_long: 1, advance_booking_days: 0, max_rate_major_city: 25000, max_rate_other_city: 20000, max_hotel_stars: 5, max_car_rate_per_day: 150, auto_approve_under: 150000, finance_approval_over: 500000 },
}

interface ColDef {
  key: LimitKey
  label: string
  unit: string
  travelType: 'flight' | 'hotel' | 'car' | 'approval'
  width: number
  isClass?: boolean
}

const COLUMNS: ColDef[] = [
  { key: 'max_fare_domestic',      label: 'Domestic fare',      unit: '₹',       travelType: 'flight',   width: 110 },
  { key: 'max_fare_intl',          label: 'Intl fare',          unit: '₹',       travelType: 'flight',   width: 110 },
  { key: 'cabin_class_short',      label: 'Class (<8hr)',       unit: '',        travelType: 'flight',   width: 100, isClass: true },
  { key: 'cabin_class_long',       label: 'Class (>8hr)',       unit: '',        travelType: 'flight',   width: 100, isClass: true },
  { key: 'advance_booking_days',   label: 'Advance (days)',     unit: 'days',    travelType: 'flight',   width: 90  },
  { key: 'max_rate_major_city',    label: 'Hotel (major)',      unit: '₹/night', travelType: 'hotel',    width: 110 },
  { key: 'max_rate_other_city',    label: 'Hotel (other)',      unit: '₹/night', travelType: 'hotel',    width: 110 },
  { key: 'max_hotel_stars',        label: 'Stars (max)',        unit: '★',       travelType: 'hotel',    width: 80  },
  { key: 'max_car_rate_per_day',   label: 'Car (₹/day)',        unit: '₹',       travelType: 'car',      width: 90  },
  { key: 'auto_approve_under',     label: 'Auto-approve <',     unit: '₹',       travelType: 'approval', width: 120 },
  { key: 'finance_approval_over',  label: 'Finance approval >', unit: '₹',       travelType: 'approval', width: 130 },
]

const TRAVEL_TYPE_LABELS: Record<string, string> = {
  flight: 'Flights', hotel: 'Hotels', car: 'Car rental', approval: 'Approval thresholds',
}

const TRAVEL_TYPE_COLORS: Record<string, string> = {
  flight: '#EEF2FF', hotel: '#F0FDF4', car: '#FFF7ED', approval: '#F9FAFB',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildDefaultRows(): PolicyRow[] {
  const rows: PolicyRow[] = []
  for (const band of BAND_CODES) {
    const defaults = DEFAULTS[band]
    for (const col of COLUMNS) {
      rows.push({
        band,
        travel_type: col.travelType,
        limit_key: col.key,
        limit_value: Number(defaults[col.key]),
        locked: false,
      })
    }
  }
  return rows
}

function rowsToGrid(rows: PolicyRow[]): Record<string, Record<string, number>> {
  const grid: Record<string, Record<string, number>> = {}
  for (const band of BAND_CODES) {
    grid[band] = {}
    for (const col of COLUMNS) grid[band][col.key] = 0
  }
  for (const row of rows) {
    if (grid[row.band]) grid[row.band][row.limit_key] = row.limit_value
  }
  return grid
}

function gridToRows(
  grid: Record<string, Record<string, number>>,
  lockedKeys: Set<string>
): PolicyRow[] {
  const rows: PolicyRow[] = []
  for (const band of BAND_CODES) {
    for (const col of COLUMNS) {
      const key = `${band}::${col.travelType}::${col.key}`
      rows.push({
        band,
        travel_type: col.travelType,
        limit_key: col.key,
        limit_value: grid[band]?.[col.key] ?? 0,
        locked: lockedKeys.has(key),
      })
    }
  }
  return rows
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SettingsPolicyPage() {
  const [grid, setGrid] = useState<Record<string, Record<string, number>>>({})
  const [lockedKeys, setLockedKeys] = useState<Set<string>>(new Set())
  const [groups, setGroups] = useState<PolicyGroup[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [currentVersion, setCurrentVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [isDefault, setIsDefault] = useState(false)

  useEffect(() => {
    loadPolicy(selectedGroupId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId])

  async function loadPolicy(groupId: string | null) {
    setLoading(true)
    setError('')
    try {
      const url = groupId
        ? `/api/settings/policy?groupId=${groupId}`
        : '/api/settings/policy'
      const res = await fetch(url)
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed to load policy'); return }

      setGroups(data.groups)
      setCurrentVersion(data.version)

      if (data.rows.length === 0) {
        setGrid(rowsToGrid(buildDefaultRows()))
        setLockedKeys(new Set())
        setIsDefault(true)
      } else {
        setGrid(rowsToGrid(data.rows))
        const locked = new Set<string>(
          data.rows
            .filter((r: PolicyRow) => r.locked)
            .map((r: PolicyRow) => `${r.band}::${r.travel_type}::${r.limit_key}`)
        )
        setLockedKeys(locked)
        setIsDefault(false)
      }
    } finally {
      setLoading(false)
    }
  }

  function handleCellChange(band: string, key: LimitKey, value: string) {
    const lockKey = `${band}::${COLUMNS.find(c => c.key === key)?.travelType}::${key}`
    if (lockedKeys.has(lockKey)) return
    setGrid(prev => ({
      ...prev,
      [band]: { ...prev[band], [key]: Number(value) || 0 },
    }))
    setSuccess('')
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const rows = gridToRows(grid, lockedKeys)
      const res = await fetch('/api/settings/policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: rows, policyGroupId: selectedGroupId }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed to save policy'); return }
      setCurrentVersion(data.newVersion)
      setIsDefault(false)
      setSuccess(`Policy saved as version ${data.newVersion}.`)
    } finally {
      setSaving(false)
    }
  }

  const travelTypes = ['flight', 'hotel', 'car', 'approval'] as const

  return (
    <div style={s.root}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.pageTitle}>Travel Policy</h1>
          <p style={s.pageSub}>
            {currentVersion === 0 || isDefault
              ? 'Pre-filled with standard defaults. Edit and save to create your policy.'
              : `Version ${currentVersion} · Locked rows are set by your TMC and cannot be edited.`
            }
          </p>
        </div>
        <div style={s.headerRight}>
          {groups.length > 0 && (
            <select
              value={selectedGroupId ?? ''}
              onChange={e => setSelectedGroupId(e.target.value || null)}
              style={s.groupSelect}
            >
              <option value="">Default policy</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={{ ...s.saveBtn, opacity: saving || loading ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : isDefault ? 'Save defaults →' : 'Save changes →'}
          </button>
        </div>
      </div>

      {isDefault && (
        <div style={s.infoBanner}>
          These are standard defaults. They are not saved yet —
          review and hit <strong>Save defaults</strong> to activate your policy.
        </div>
      )}

      {success && <div style={s.successBanner}>✓ {success}</div>}
      {error   && <div style={s.errorBanner}>✕ {error}</div>}

      {loading ? (
        <div style={s.loadingWrap}>
          <p style={s.loadingText}>Loading policy…</p>
        </div>
      ) : (
        <div style={s.tables}>
          {travelTypes.map(tt => {
            const cols = COLUMNS.filter(c => c.travelType === tt)
            return (
              <div key={tt} style={s.tableSection}>
                <div style={{ ...s.tableSectionHeader, background: TRAVEL_TYPE_COLORS[tt] }}>
                  <span style={s.tableSectionTitle}>{TRAVEL_TYPE_LABELS[tt]}</span>
                </div>
                <div style={s.tableWrap}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={{ ...s.th, ...s.stickyCol, width: 130 }}>Band</th>
                        {cols.map(col => (
                          <th key={col.key} style={{ ...s.th, width: col.width }}>
                            <span style={s.colLabel}>{col.label}</span>
                            {col.unit && <span style={s.colUnit}>{col.unit}</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {BAND_CODES.map((band, ri) => (
                        <tr key={band} style={{ background: ri % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                          <td style={{ ...s.td, ...s.stickyCol }}>
                            <div style={s.bandCell}>
                              <span style={s.bandBadge}>{band}</span>
                              <span style={s.bandLabel}>{BAND_LABELS[band]}</span>
                            </div>
                          </td>
                          {cols.map(col => {
                            const lockKey = `${band}::${tt}::${col.key}`
                            const isLocked = lockedKeys.has(lockKey)
                            const val = grid[band]?.[col.key] ?? 0

                            if (col.isClass) {
                              return (
                                <td key={col.key} style={s.td}>
                                  <select
                                    value={val}
                                    onChange={e => handleCellChange(band, col.key, e.target.value)}
                                    disabled={isLocked}
                                    style={{
                                      ...s.cellSelect,
                                      opacity: isLocked ? 0.5 : 1,
                                      cursor: isLocked ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    <option value={0}>Economy</option>
                                    <option value={1}>Business</option>
                                    <option value={2}>First</option>
                                  </select>
                                </td>
                              )
                            }

                            return (
                              <td key={col.key} style={s.td}>
                                {isLocked ? (
                                  <div style={s.lockedCell}>
                                    <span style={s.lockedValue}>{val.toLocaleString()}</span>
                                    <span style={s.lockIcon} title="Locked by TMC">🔒</span>
                                  </div>
                                ) : (
                                  <input
                                    type="number"
                                    value={val}
                                    onChange={e => handleCellChange(band, col.key, e.target.value)}
                                    style={s.cellInput}
                                    min={0}
                                  />
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p style={s.footNote}>
        Locked rows (🔒) are set by your TMC and cannot be edited here.
        Contact your TMC to request changes to locked rules.
        Each save creates a new version — your full policy history is preserved.
      </p>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' },
  pageTitle: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  pageSub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  headerRight: { display: 'flex', gap: '10px', alignItems: 'center', flexShrink: 0 },
  groupSelect: { height: '34px', padding: '0 10px', fontSize: '13px', color: '#374151', background: '#fff', border: '1px solid #D1D5DB', borderRadius: '7px', outline: 'none', cursor: 'pointer' },
  saveBtn: { height: '34px', padding: '0 18px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: '7px', cursor: 'pointer' },
  infoBanner: { marginBottom: '16px', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#92400E', lineHeight: '1.5' },
  successBanner: { marginBottom: '16px', background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#065F46' },
  errorBanner: { marginBottom: '16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#DC2626' },
  loadingWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px' },
  loadingText: { fontSize: '13px', color: '#9CA3AF' },
  tables: { display: 'flex', flexDirection: 'column', gap: '20px' },
  tableSection: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflow: 'hidden' },
  tableSectionHeader: { padding: '10px 16px', borderBottom: '1px solid #E5E7EB' },
  tableSectionTitle: { fontSize: '12px', fontWeight: 600, color: '#374151', letterSpacing: '0.3px' },
  tableWrap: { overflowX: 'auto' as const },
  table: { borderCollapse: 'collapse' as const, width: '100%', minWidth: '500px' },
  th: { padding: '8px 10px', textAlign: 'left' as const, background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' as const },
  colLabel: { display: 'block', fontSize: '11px', fontWeight: 600, color: '#374151' },
  colUnit: { fontSize: '10px', color: '#9CA3AF', fontWeight: 400 },
  stickyCol: { position: 'sticky' as const, left: 0, zIndex: 1, background: '#F9FAFB', borderRight: '1px solid #E5E7EB' },
  td: { padding: '7px 8px', borderBottom: '1px solid #F3F4F6', verticalAlign: 'middle' as const },
  bandCell: { display: 'flex', alignItems: 'center', gap: '7px' },
  bandBadge: { display: 'inline-block', padding: '2px 6px', background: '#EEF2FF', color: '#3730A3', fontSize: '10px', fontWeight: 700, borderRadius: '4px' },
  bandLabel: { fontSize: '12px', color: '#374151', fontWeight: 500 },
  cellInput: { width: '100%', height: '28px', padding: '0 7px', fontSize: '12px', color: '#111827', background: '#F9FAFB', border: '1px solid transparent', borderRadius: '4px', outline: 'none' },
  cellSelect: { width: '100%', height: '28px', padding: '0 5px', fontSize: '12px', color: '#111827', background: '#F9FAFB', border: '1px solid transparent', borderRadius: '4px', outline: 'none' },
  lockedCell: { display: 'flex', alignItems: 'center', gap: '6px' },
  lockedValue: { fontSize: '12px', color: '#6B7280' },
  lockIcon: { fontSize: '11px' },
  footNote: { fontSize: '11px', color: '#9CA3AF', lineHeight: '1.6', margin: '20px 0 0' },
}