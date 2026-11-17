'use client'

import { useEffect, useMemo, useState } from 'react'
import { ALL_FIELDS } from '@/app/lib/policy/fields'
import PolicyAccordion, { type Grid } from '@/app/components/policy/PolicyAccordion'

// ── Settings → Policy: the travel policy in force, read-only ─────────────────
// The TMC owns policy (groups are its templates, shared across companies), so
// the company admin reads it here and changes nothing. The same layout as the
// TMC's editor (PolicyAccordion): pick a policy group, see its limits one
// section at a time. Each group says which of the company's own bands it
// covers. Bands with no policy in force are named above, with why.
// ─────────────────────────────────────────────────────────────────────────────

interface Band { code: string; label: string; rank: number }

interface Rule { limit_key: string; limit_value: number | null; limit_bool: boolean | null; limit_list: string[] | null }

interface Group {
  id: string
  name: string
  code: string | null
  bandRanks: number[]
  version: number
  rules: Rule[]
}

interface UnresolvedBand {
  band_code: string
  band_label: string
  band_rank: number
  reason: 'no_policy_group' | 'overlapping_policy_groups' | 'no_policy_rules'
  detail: string
}

interface PolicyView {
  bands: Band[]
  groups: Group[]
  unresolved: UnresolvedBand[]
  withinPolicyApproval: 'auto' | 'required' | null
}

// A group's limits as the accordion reads them. A field with no rule is "not
// set" (a boolean takes its default), exactly as the TMC's editor shows it.
function gridOf(rules: Rule[]): Grid {
  const g: Grid = {}
  for (const f of ALL_FIELDS) g[f.key] = f.kind === 'boolean' ? f.defaultBool ?? false : f.kind === 'list' ? [] : null
  for (const r of rules) g[r.limit_key] = r.limit_value ?? r.limit_bool ?? r.limit_list ?? null
  return g
}

export default function SettingsPolicyPage() {
  const [view, setView] = useState<PolicyView | null>(null)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/settings/policy')
      .then(async res => ({ res, data: await res.json() }))
      .then(({ res, data }) => {
        if (!live) return
        if (!res.ok) { setError(data.error || 'Could not load the travel policy.'); return }
        setView(data)
        setSelectedId(data.groups[0]?.id ?? null)
      })
      .catch(() => { if (live) setError('Could not load the travel policy. Check your connection and try again.') })
    return () => { live = false }
  }, [])

  const selected = view?.groups.find(g => g.id === selectedId) ?? null
  const grid = useMemo(() => gridOf(selected?.rules ?? []), [selected])
  // The company's bands each group reaches, in rank order.
  const bandsOf = (g: Group) => (view?.bands ?? []).filter(b => g.bandRanks.includes(b.rank)).sort((a, b) => a.rank - b.rank)

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.title}>Travel policy</h1>
        <p style={s.sub}>Set by your travel management company for each band. To change anything here, contact them.</p>
      </div>

      {error && <div style={s.errorBanner} role="alert">{error}</div>}

      {!view && !error && (
        <div style={s.loading} aria-busy="true">
          {[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: i === 0 ? 64 : 44, borderRadius: 10 }} />)}
        </div>
      )}

      {view && view.bands.length === 0 && (
        <div style={s.notice}>
          <strong>No employee bands are set up for your company.</strong> Travel policy applies per band, so none is in force
          until bands exist. Ask your travel management company to set them up.
        </div>
      )}

      {view && view.bands.length > 0 && view.unresolved.length > 0 && (
        <div style={s.notice}>
          <strong>
            {view.unresolved.length === view.bands.length
              ? 'No travel policy is in force yet.'
              : `${view.unresolved.length} of your ${view.bands.length} bands have no policy in force.`}
          </strong>
          <ul style={s.noticeList}>
            {view.unresolved.map(u => (
              <li key={u.band_code}><strong>{u.band_code}</strong> ({u.band_label}): {u.detail}</li>
            ))}
          </ul>
          Bookings by people in these bands are not checked against a policy. Ask your travel management company to link a
          policy group that covers them.
        </div>
      )}

      {view && view.groups.length > 0 && (
        <>
          {/* One card per group: which of your bands it covers. */}
          <div style={s.groups} role="tablist" aria-label="Policy groups">
            {view.groups.map(g => {
              const on = g.id === selectedId
              const covered = bandsOf(g)
              return (
                <button key={g.id} type="button" role="tab" aria-selected={on} onClick={() => setSelectedId(g.id)}
                  style={{ ...s.group, ...(on ? s.groupOn : {}) }}>
                  <span style={s.groupName}>{g.name}</span>
                  <span style={{ ...s.groupBands, ...(on ? s.groupBandsOn : {}) }}>
                    {covered.length ? covered.map(b => b.code).join(', ') : 'None of your bands'}
                    {g.version > 0 ? ` · v${g.version}` : ''}
                  </span>
                </button>
              )
            })}
          </div>

          {selected && (
            <section style={s.panel} role="tabpanel" aria-label={selected.name}>
              <div style={s.panelHead}>
                <div>
                  <h2 style={s.panelTitle}>{selected.name}</h2>
                  <p style={s.panelSub}>
                    {bandsOf(selected).length
                      ? <>Applies to {bandsOf(selected).map((b, i) => <span key={b.code}>{i > 0 && ', '}<strong>{b.code}</strong> {b.label}</span>)}</>
                      : 'Covers no band at your company, so it applies to nobody here.'}
                  </p>
                </div>
                {selected.code && <span style={s.code}>{selected.code}</span>}
              </div>

              {selected.rules.length === 0 ? (
                <p style={s.empty}>No limits are set in this group yet.</p>
              ) : (
                <PolicyAccordion
                  grid={grid} readOnly
                  extra={cat => cat.id === 'booking_rights' && view.withinPolicyApproval && (
                    <div style={s.override}>
                      <strong>Your company&apos;s own setting applies here:</strong> within-policy bookings are{' '}
                      {view.withinPolicyApproval === 'required' ? 'sent for approval' : 'approved automatically'}, whatever this group says.
                    </div>
                  )}
                />
              )}
            </section>
          )}
        </>
      )}

      <p style={s.foot}>
        &ldquo;No limit&rdquo; and &ldquo;Not set&rdquo; mean the group places no restriction there. Bookings outside these limits
        need approval or are refused, depending on your company&apos;s settings.
      </p>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: 960 },
  header: { marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0 },
  errorBanner: { marginBottom: 16, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: '#DC2626' },
  loading: { display: 'flex', flexDirection: 'column', gap: 10 },
  notice: { marginBottom: 16, background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '12px 14px', fontSize: 12.5, color: '#92400E', lineHeight: 1.6 },
  noticeList: { margin: '6px 0', paddingLeft: 18 },

  groups: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  group: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 160, textAlign: 'left',
    padding: '9px 14px', background: '#fff', color: '#111827', border: '1px solid #E5E7EB', borderRadius: 10, cursor: 'pointer',
  },
  groupOn: { background: '#000835', borderColor: '#000835', color: '#fff' },
  groupName: { fontSize: 13, fontWeight: 600, color: 'inherit' },
  groupBands: { fontSize: 11.5, color: '#6B7280' },
  groupBandsOn: { color: '#C9CDEA' },

  panel: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 16 },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  panelTitle: { fontSize: 15, fontWeight: 600, color: '#111827', margin: '0 0 3px' },
  panelSub: { fontSize: 12.5, color: '#6B7280', margin: 0, lineHeight: 1.5 },
  code: { fontSize: 11, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 5, padding: '3px 8px', whiteSpace: 'nowrap' },
  empty: { fontSize: 13, color: '#6B7280', margin: '8px 0' },
  override: { margin: '4px 16px 12px', fontSize: 12, color: '#4C1D95', background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5 },
  foot: { fontSize: 11.5, color: '#9CA3AF', lineHeight: 1.6, margin: '18px 0 0' },
}
