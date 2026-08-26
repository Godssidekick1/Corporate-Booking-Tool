'use client'

import { useEffect, useMemo, useState } from 'react'

// ── /settings/hierarchy ─────────────────────────────────────────────────
// Lets a corporate admin assign each employee's manager (employees.manager_id).
// This directly feeds the Approval Engine: approval_chain_tiers with
// approver_type='manager' resolve to whatever's set here
// (see app/lib/approval-engine/resolveApprovalTier.ts). An employee with no
// manager assigned, on a chain that requires manager approval, will land on
// 'approval_misconfigured' rather than silently auto-approving — this page
// is how that gap actually gets closed.
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
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', manager: 'Manager', finance: 'Finance', employee: 'Employee',
}

export default function SettingsHierarchyPage() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    loadEmployees()
  }, [])

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
    } catch {
      setError('Something went wrong loading employees.')
    } finally {
      setLoading(false)
    }
  }

  async function handleManagerChange(employeeId: string, managerId: string) {
    setError('')
    setSuccess('')
    setSavingId(employeeId)

    // Optimistic update — reverted below if the request fails. Cycle
    // detection happens server-side (walks the full chain, not just one
    // hop), so this optimistic write can be wrong in the cycle case; the
    // catch block below restores the previous list on any error.
    const previous = employees
    setEmployees(prev => prev.map(e => e.id === employeeId ? { ...e, manager_id: managerId || null } : e))

    try {
      const res = await fetch(`/api/settings/users/${employeeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managerId: managerId || null }),
      })
      const data = await res.json()

      if (!res.ok) {
        setEmployees(previous)
        setError(data.error || 'Could not update manager.')
        return
      }

      setSuccess(`Updated ${data.employee.full_name}'s manager.`)
    } catch {
      setEmployees(previous)
      setError('Something went wrong. Please try again.')
    } finally {
      setSavingId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return employees
    return employees.filter(e =>
      e.full_name.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      (e.department ?? '').toLowerCase().includes(q)
    )
  }, [employees, query])

  const unassignedCount = employees.filter(e => e.status === 'active' && !e.manager_id).length

  // Candidates for a given employee's manager dropdown: everyone else in
  // the company except the employee themself. Self-reference is blocked
  // here for UX (no point letting them pick it and then get a 400), but
  // the real, authoritative check — including multi-hop cycles — happens
  // server-side in the PATCH route.
  function candidatesFor(employeeId: string): Employee[] {
    return employees.filter(e => e.id !== employeeId)
  }

  if (loading) {
    return (
      <div style={s.page}>
        <div style={s.loadingRow}>
          <div style={s.spinner} />
        </div>
      </div>
    )
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Reporting hierarchy</h1>
          <p style={s.sub}>
            Assign each employee's manager. Approvals that need manager sign-off route based on this — an employee
            with no manager set will show as misconfigured when a booking needs their approval.
          </p>
        </div>
        <input
          type="text"
          placeholder="Search by name, email, department…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={s.search}
        />
      </div>

      {unassignedCount > 0 && (
        <div style={s.warningBanner}>
          <span style={s.bannerIcon}>⚠</span>
          {unassignedCount} active employee{unassignedCount > 1 ? 's have' : ' has'} no manager assigned. Bookings
          that need manager approval for {unassignedCount > 1 ? 'them' : 'this person'} will fail to route until this is set.
        </div>
      )}

      {error && (
        <div style={s.errorBanner}><span style={s.bannerIcon}>⚠</span> {error}</div>
      )}
      {success && (
        <div style={s.successBanner}><span style={s.bannerIcon}>✓</span> {success}</div>
      )}

      <div style={s.tableCard}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Employee</th>
              <th style={s.th}>Role</th>
              <th style={s.th}>Band</th>
              <th style={s.th}>Manager</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(emp => {
              const missingManager = emp.status === 'active' && !emp.manager_id
              return (
                <tr key={emp.id} style={s.tr}>
                  <td style={s.td}>
                    <div style={s.nameCell}>
                      <span style={s.name}>{emp.full_name}</span>
                      <span style={s.email}>{emp.email}</span>
                    </div>
                  </td>
                  <td style={s.td}>
                    <span style={s.roleBadge}>{ROLE_LABEL[emp.role] ?? emp.role}</span>
                  </td>
                  <td style={s.td}>{emp.band_code ?? '—'}</td>
                  <td style={s.td}>
                    <div style={s.managerCell}>
                      <select
                        value={emp.manager_id ?? ''}
                        onChange={e => handleManagerChange(emp.id, e.target.value)}
                        disabled={savingId === emp.id}
                        style={{ ...s.select, ...(missingManager ? s.selectMissing : {}) }}
                      >
                        <option value="">No manager assigned</option>
                        {candidatesFor(emp.id).map(candidate => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.full_name} ({ROLE_LABEL[candidate.role] ?? candidate.role})
                          </option>
                        ))}
                      </select>
                      {savingId === emp.id && <div style={s.spinnerTiny} />}
                      {missingManager && <span style={s.missingDot} title="No manager assigned" />}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div style={s.emptyState}>No employees match your search.</div>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { fontFamily: "'Inter', -apple-system, sans-serif", padding: '32px', maxWidth: '1000px', margin: '0 auto' },

  loadingRow: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '24px', height: '24px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  spinnerTiny: { width: '14px', height: '14px', border: '2px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', flexShrink: 0, animation: 'spin 0.7s linear infinite' },

  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', marginBottom: '20px', flexWrap: 'wrap' as const },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5, maxWidth: '560px' },
  search: {
    height: '38px', padding: '0 14px', fontSize: '13px', color: '#111827',
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '8px', outline: 'none', minWidth: '240px',
  },

  warningBanner: {
    display: 'flex', alignItems: 'center', gap: '8px', background: '#FFFBEB', border: '1px solid #FDE68A',
    borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#92400E', marginBottom: '16px', lineHeight: 1.5,
  },
  errorBanner: {
    display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px',
  },
  successBanner: {
    display: 'flex', alignItems: 'center', gap: '8px', background: '#F0FDF4', border: '1px solid #BBF7D0',
    borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#166534', marginBottom: '16px',
  },
  bannerIcon: { fontSize: '14px', flexShrink: 0 },

  tableCard: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: {
    textAlign: 'left' as const, fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const,
    letterSpacing: '0.4px', padding: '12px 16px', borderBottom: '1px solid #E5E7EB', background: '#F9FAFB',
  },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '12px 16px', fontSize: '13px', color: '#111827', verticalAlign: 'middle' as const },

  nameCell: { display: 'flex', flexDirection: 'column' as const, gap: '2px' },
  name: { fontWeight: 600, color: '#111827' },
  email: { fontSize: '11.5px', color: '#9CA3AF' },

  roleBadge: {
    fontSize: '11px', fontWeight: 600, color: '#3730A3', background: '#EEF2FF',
    padding: '3px 9px', borderRadius: '6px', letterSpacing: '0.2px',
  },

  managerCell: { display: 'flex', alignItems: 'center', gap: '8px' },
  select: {
    height: '34px', padding: '0 10px', fontSize: '12.5px', color: '#111827',
    background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '7px', outline: 'none', minWidth: '220px',
  },
  selectMissing: { borderColor: '#FDE68A', background: '#FFFBEB' },
  missingDot: { width: '7px', height: '7px', borderRadius: '50%', background: '#F59E0B', flexShrink: 0 },

  emptyState: { padding: '40px 20px', textAlign: 'center' as const, fontSize: '13px', color: '#9CA3AF' },
}