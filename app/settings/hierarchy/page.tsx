'use client'

import { useEffect, useMemo, useState } from 'react'

// ── /settings/hierarchy ─────────────────────────────────────────────────
// Read-only view of who reports to whom (employees.manager_id).
//
// Editing moved to the TMC (/tmc/settings/hierarchy). The TMC configures
// approval routing, and a step of type 'manager' resolves through manager_id —
// so if only the corporate admin could set it, a TMC could build a chain whose
// first step resolves to nobody and have no way to fix it. Same split as
// policy: the TMC owns it, the client sees it.
//
// An employee with no manager, on a chain with a manager step, resolves to no
// approver at all rather than silently auto-approving, so the gaps are still
// worth surfacing here even though this page can't close them.
// ─────────────────────────────────────────────────────────────────────────────

interface Employee {
  id: string
  full_name: string
  email: string
  role: 'admin' | 'manager' | 'finance' | 'employee'
  status: string
  band_code: string | null
  department: string | null
  manager_id: string | null
  top_of_hierarchy: boolean
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', manager: 'Manager', finance: 'Finance', employee: 'Employee',
}

export default function SettingsHierarchyPage() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => { loadEmployees() }, [])

  async function loadEmployees() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/settings/users')
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Could not load employees.')
        return
      }
      setEmployees(data.employees)
    } finally {
      setLoading(false)
    }
  }

  const nameById = useMemo(
    () => new Map(employees.map(e => [e.id, e.full_name])),
    [employees]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return employees
    return employees.filter(e =>
      e.full_name.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      (e.department ?? '').toLowerCase().includes(q)
    )
  }, [employees, query])

  // Someone at the top of the org has no manager by design. Counting them made
  // the company owner a permanent, unclearable warning.
  const unassignedCount = employees.filter(
    e => e.status === 'active' && !e.manager_id && !e.top_of_hierarchy
  ).length

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Reporting hierarchy</h1>
          <p style={s.sub}>
            Who each person reports to. Approvals that route to &quot;the traveller&apos;s manager&quot;
            follow this. Maintained by your TMC — contact them to change it.
          </p>
        </div>
      </div>

      {error && <div style={s.errorBanner}>✕ {error}</div>}

      {!loading && unassignedCount > 0 && (
        <div style={s.warnBanner}>
          <strong>{unassignedCount} active employee{unassignedCount === 1 ? '' : 's'}</strong> have no
          manager set. Any approval step routing to their manager cannot resolve, so those bookings
          go through unapproved. Ask your TMC to complete the reporting lines.
        </div>
      )}

      <input
        type="search"
        placeholder="Search name, email or department…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={s.search}
      />

      {loading ? (
        <div style={s.loadingWrap}><div style={s.spinner} /></div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Employee', 'Role', 'Band', 'Department', 'Reports to'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(emp => {
                const missingManager = emp.status === 'active' && !emp.manager_id && !emp.top_of_hierarchy
                return (
                  <tr key={emp.id} style={s.tr}>
                    <td style={s.td}>
                      <div style={s.name}>{emp.full_name}</div>
                      <div style={s.email}>{emp.email}</div>
                    </td>
                    <td style={s.td}>{ROLE_LABEL[emp.role] ?? emp.role}</td>
                    <td style={s.td}>
                      {emp.band_code ? <span style={s.bandBadge}>{emp.band_code}</span> : <span style={s.muted}>—</span>}
                    </td>
                    <td style={s.td}>{emp.department || <span style={s.muted}>—</span>}</td>
                    <td style={s.td}>
                      {emp.manager_id
                        ? (nameById.get(emp.manager_id) ?? <span style={s.muted}>Unknown</span>)
                        : emp.top_of_hierarchy
                          ? <span style={s.topBadge}>Top of hierarchy</span>
                          : missingManager
                            ? <span style={s.missing}>Not set</span>
                            : <span style={s.muted}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  header: { marginBottom: '16px' },
  title: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  errorBanner: { marginBottom: '16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#DC2626' },
  warnBanner: { marginBottom: '16px', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: '#92400E', lineHeight: 1.6 },

  search: { height: '38px', width: '100%', maxWidth: '360px', padding: '0 12px', fontSize: '13px', color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: '8px', outline: 'none', marginBottom: '16px' },

  loadingWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px' },
  spinner: { width: '24px', height: '24px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },

  tableWrap: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '10px 14px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: '11px', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '10px 14px', fontSize: '13px', color: '#374151', verticalAlign: 'middle' },

  name: { fontSize: '13px', fontWeight: 500, color: '#111827' },
  email: { fontSize: '11px', color: '#9CA3AF' },
  bandBadge: { display: 'inline-block', padding: '2px 7px', background: '#EEF2FF', color: '#3730A3', fontSize: '10px', fontWeight: 700, borderRadius: '4px' },
  muted: { color: '#9CA3AF' },
  missing: { fontSize: '11px', fontWeight: 600, color: '#92400E', background: '#FEF3C7', borderRadius: '4px', padding: '2px 8px' },
  topBadge: { fontSize: '11px', fontWeight: 600, color: '#065F46', background: '#ECFDF5', borderRadius: '4px', padding: '2px 8px' },
}
