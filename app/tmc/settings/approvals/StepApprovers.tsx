'use client'

import { useEffect, useState } from 'react'

// ── StepApprovers ────────────────────────────────────────────────────────────
// Who fills each step of one approval chain at one company.
//
// Used by BOTH the direct-mapping flow and the assign-a-template flow, which is
// the point: a company-owned chain and an adopted shared template are
// configured in exactly the same place, the same way. The structure/binding
// split never surfaces as vocabulary.
//
// A step left unset raises no approval at all, so that state is called out
// rather than left to be inferred from an empty dropdown.
// ─────────────────────────────────────────────────────────────────────────────

export type ApproverType =
  'manager' | 'any_manager_at' | 'finance_role' | 'admin' | 'self' | 'specific_user'

export interface TemplateStep {
  tier: number
  min_verdict: string
  label?: string | null
}

export interface Binding {
  tier: number
  approver_type: ApproverType
  approver_user_id?: string | null
  min_band_rank?: number | null
}

interface Employee {
  id: string
  full_name: string
  band_code: string | null
  manager_id: string | null
  top_of_hierarchy: boolean
}

const APPROVER_TYPES: { value: ApproverType; label: string }[] = [
  { value: 'manager',        label: "The traveller's own manager" },
  { value: 'specific_user',  label: 'A specific person…' },
  { value: 'any_manager_at', label: 'Any manager at rank…' },
  { value: 'finance_role',   label: 'Finance' },
  { value: 'admin',          label: 'Company admin' },
  { value: 'self',           label: 'No review needed (auto-approve)' },
]

const VERDICT_LABEL: Record<string, string> = {
  green: 'Always',
  amber: 'Amber and worse',
  red: 'Red only',
}

interface Props {
  companyId: string
  templateId: string
  steps: TemplateStep[]
}

export default function StepApprovers({ companyId, templateId, steps }: Props) {
  const [bindings, setBindings] = useState<Binding[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [savingTier, setSavingTier] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!companyId || !templateId) return
    let cancelled = false

    async function load() {
      setLoading(true); setError('')
      try {
        const [bindingData, employeeData] = await Promise.all([
          fetch(`/api/tmc/approval-tier-approvers?companyId=${companyId}&templateId=${templateId}`).then(r => r.json()),
          fetch(`/api/tmc/employees?companyId=${companyId}`).then(r => r.json()),
        ])
        if (cancelled) return
        if (!bindingData.ok) { setError(bindingData.error || 'Could not load approvers.'); return }
        setBindings(bindingData.bindings)
        if (employeeData.ok) setEmployees(employeeData.employees)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [companyId, templateId])

  const byTier = new Map(bindings.map(b => [b.tier, b]))

  async function save(tier: number, patch: Partial<Binding>) {
    const current = byTier.get(tier)
    const next: Binding = {
      tier,
      approver_type: patch.approver_type ?? current?.approver_type ?? 'manager',
      approver_user_id: patch.approver_user_id !== undefined ? patch.approver_user_id : current?.approver_user_id,
      min_band_rank: patch.min_band_rank !== undefined ? patch.min_band_rank : current?.min_band_rank,
    }

    // These two need a second choice before the step means anything. Hold the
    // selection locally until it's complete rather than POSTing something the
    // API would only reject.
    const incomplete =
      (next.approver_type === 'specific_user' && !next.approver_user_id) ||
      (next.approver_type === 'any_manager_at' && (next.min_band_rank === null || next.min_band_rank === undefined))

    setBindings(prev => {
      const rest = prev.filter(b => b.tier !== tier)
      return [...rest, next].sort((a, b) => a.tier - b.tier)
    })

    if (incomplete) return

    setSavingTier(tier); setError('')
    try {
      const d = await fetch('/api/tmc/approval-tier-approvers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          templateId,
          tier,
          approverType: next.approver_type,
          approverUserId: next.approver_user_id ?? null,
          minBandRank: next.min_band_rank ?? null,
        }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save this step.'); return }
      // Deliberately NOT re-fetching. Local state already holds what was just
      // saved, and telling the parent to reload remounted this component
      // mid-edit — the dropdown you had open closed under you every time.
    } finally { setSavingTier(null) }
  }

  async function clear(tier: number) {
    setSavingTier(tier); setError('')
    try {
      const d = await fetch(
        `/api/tmc/approval-tier-approvers?companyId=${companyId}&templateId=${templateId}&tier=${tier}`,
        { method: 'DELETE' }
      ).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not clear this step.'); return }
      setBindings(prev => prev.filter(b => b.tier !== tier))
    } finally { setSavingTier(null) }
  }

  const unboundCount = steps.filter(s => !byTier.get(s.tier)).length
  // Someone at the top of the hierarchy has no manager by design, and the
  // engine auto-approves their manager steps rather than stalling — so they are
  // not part of this gap.
  const managerlessCount = employees.filter(e => !e.manager_id && !e.top_of_hierarchy).length
  const usesManagerStep = steps.some(s => byTier.get(s.tier)?.approver_type === 'manager')

  if (loading) return <p style={s.muted}>Loading approvers…</p>

  return (
    <div style={s.wrap}>
      {error && <div style={s.errorBanner}>⚠ {error}</div>}

      {unboundCount > 0 && (
        <div style={s.warnBanner}>
          <strong>{unboundCount} step{unboundCount === 1 ? '' : 's'} have no approver.</strong>{' '}
          Bookings that reach {unboundCount === 1 ? 'it' : 'them'} raise no approval at all.
        </div>
      )}

      {usesManagerStep && managerlessCount > 0 && (
        <div style={s.warnBanner}>
          A step routes to the traveller&apos;s own manager, but{' '}
          <strong>{managerlessCount} employee{managerlessCount === 1 ? ' has' : 's have'}</strong> no
          manager set. Those bookings will not route.{' '}
          <a href="/tmc/settings/hierarchy" style={s.link}>Set reporting lines →</a>
        </div>
      )}

      <div style={s.steps}>
        {steps.map(step => {
          const bound = byTier.get(step.tier)
          const busy = savingTier === step.tier

          return (
            <div key={step.tier} style={{ ...s.step, borderColor: bound ? '#E5E7EB' : '#FDE68A' }}>
              <div style={s.stepHead}>
                <span style={s.stepBadge}>Step {step.tier}</span>
                <span style={s.stepLabel}>{step.label || 'Unnamed step'}</span>
                <span style={s.stepVerdict}>{VERDICT_LABEL[step.min_verdict] ?? step.min_verdict}</span>
              </div>

              <div style={s.stepControls}>
                <select
                  value={bound?.approver_type ?? ''}
                  onChange={e => save(step.tier, {
                    approver_type: e.target.value as ApproverType,
                    approver_user_id: null,
                    min_band_rank: null,
                  })}
                  disabled={busy}
                  style={{ ...s.input, flex: 1, minWidth: 200 }}
                >
                  <option value="" disabled>Choose who approves…</option>
                  {APPROVER_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>

                {bound?.approver_type === 'specific_user' && (
                  <select
                    value={bound.approver_user_id ?? ''}
                    onChange={e => save(step.tier, { approver_user_id: e.target.value || null })}
                    disabled={busy}
                    style={{ ...s.input, flex: 1, minWidth: 180 }}
                  >
                    <option value="">Pick a person…</option>
                    {employees.map(emp => (
                      <option key={emp.id} value={emp.id}>
                        {emp.full_name}{emp.band_code ? ` · ${emp.band_code}` : ''}
                      </option>
                    ))}
                  </select>
                )}

                {bound?.approver_type === 'any_manager_at' && (
                  <input
                    type="number" min={0} placeholder="Min rank"
                    value={bound.min_band_rank ?? ''}
                    onChange={e => save(step.tier, {
                      min_band_rank: e.target.value === '' ? null : Number(e.target.value),
                    })}
                    disabled={busy}
                    style={{ ...s.input, width: 110 }}
                  />
                )}

                {bound && (
                  <button onClick={() => clear(step.tier)} disabled={busy} style={s.clearBtn}>
                    Clear
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { marginBottom: 16 },
  muted: { fontSize: 12, color: '#9CA3AF', margin: 0 },
  link: { color: '#000835', fontWeight: 600 },
  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 12 },
  warnBanner: { background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400E', marginBottom: 12, lineHeight: 1.6 },
  steps: { display: 'flex', flexDirection: 'column', gap: 10 },
  step: { border: '1.5px solid', borderRadius: 10, padding: '12px 14px' },
  stepHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
  stepBadge: { fontSize: 10, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '3px 8px' },
  stepLabel: { fontSize: 13, fontWeight: 600, color: '#111827', flex: 1 },
  stepVerdict: { fontSize: 11, color: '#9CA3AF' },
  stepControls: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none' },
  clearBtn: { height: 30, padding: '0 12px', background: '#fff', color: '#6B7280', fontSize: 12, border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer' },
}
