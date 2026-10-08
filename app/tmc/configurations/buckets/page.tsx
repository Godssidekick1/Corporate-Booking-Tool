'use client'

import { useCallback, useState } from 'react'
import SearchableSelect from '@/app/components/SearchableSelect'
import SlideOver from '@/app/components/SlideOver'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import { useLookup } from '@/app/hooks/useLookup'

// ── /tmc/configurations/buckets ──────────────────────────────────────────────
// A bucket is a curated set of CLIENTS that deal codes, forms of payment and
// commercial rules are assigned to.
//
// Not the same thing as a client group, and the difference matters: a client
// group is the org hierarchy a client belongs to — a fact about them — while a
// bucket is a distribution decision someone made on purpose ("Tier 1
// corporates", "North India desk") and cuts across groups freely.
//
// Same shape as the other masters: the list is a table, and a bucket is edited
// in the slide-over. Edits there are staged and saved together, so adding five
// clients is one change (and one "updated by"), not five.
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket {
  id: string
  name: string
  code: string | null
  description: string | null
  clientCount: number
  memberPreview: string[]
  dealCodeCount: number
  fopCount: number
  ruleCount: number
  updated_at: string
  updated_by_name: string | null
}
interface Member { id: string; name: string; status?: string }
interface DealCodeRef { id: string; code: string; code_type: string; airline_code: string }
interface FopRef { id: string; fop_code: string; label: string; payer: string; fop_type: string }
interface RuleRef { id: string; kind: string; airline_code: string | null; calc_type: string; rate: number; active: boolean }
interface Uses { dealCodes: DealCodeRef[]; fops: FopRef[]; commercialRules: RuleRef[] }

type Fields = { name: string; code: string; description: string }
const EMPTY_FIELDS: Fields = { name: '', code: '', description: '' }
const NO_USES: Uses = { dealCodes: [], fops: [], commercialRules: [] }

const USED_BY_FILTERS = [
  { id: '', label: 'Used by: Any' },
  { id: 'deal_codes', label: 'Used by: Deal codes' },
  { id: 'fops', label: 'Used by: Payment methods' },
  { id: 'commercials', label: 'Used by: Commercial rules' },
  { id: 'none', label: 'Not used yet' },
]

const RULE_KIND: Record<string, { label: string; href: string }> = {
  markup: { label: 'Markup', href: '/tmc/configurations/markup' },
  discount: { label: 'Discount', href: '/tmc/configurations/discounts' },
  processing_fee: { label: 'Processing fee', href: '/tmc/configurations/processing-fees' },
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?'
}

function ruleLabel(r: RuleRef): string {
  const amount = r.calc_type === 'percent' ? `${r.rate}%` : `₹${r.rate.toLocaleString('en-IN')}`
  return [RULE_KIND[r.kind]?.label ?? r.kind, r.airline_code ?? 'All airlines', amount].join(' · ')
}

export default function BucketsPage() {
  const [usedBy, setUsedBy] = useState('')
  const list = usePagedList<Bucket>('/api/tmc/buckets', { params: { usedBy: usedBy || undefined } })

  // The editor. `editing.id` null = a new bucket.
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS)
  const [members, setMembers] = useState<Member[]>([])
  const [uses, setUses] = useState<Uses>(NO_USES)
  // What was loaded, to tell whether anything changed.
  const [original, setOriginal] = useState('')
  const [addClientId, setAddClientId] = useState('')

  const [busy, setBusy] = useState(false)
  const [panelError, setPanelError] = useState('')
  const [success, setSuccess] = useState('')

  // Server-searched rather than loaded whole, so a TMC with hundreds of
  // clients does not download all of them to add one to a bucket.
  const clientLookup = useLookup('/api/tmc/clients', addClientId, { enabled: editing !== null })

  const snapshot = (f: Fields, m: Member[]) => JSON.stringify([f, m.map(x => x.id)])
  const dirty = editing !== null && snapshot(fields, members) !== original

  async function openBucket(id: string) {
    setEditing({ id }); setPanelError(''); setSuccess(''); setAddClientId('')
    setLoadingDetail(true)
    try {
      const d = await fetch(`/api/tmc/buckets/${id}`).then(r => r.json())
      if (!d.ok) { setPanelError(d.error || 'Could not load that bucket.'); return }
      const f = { name: d.bucket.name, code: d.bucket.code ?? '', description: d.bucket.description ?? '' }
      setFields(f)
      setMembers(d.clients)
      setUses({ dealCodes: d.dealCodes, fops: d.fops, commercialRules: d.commercialRules })
      setOriginal(snapshot(f, d.clients))
    } catch {
      setPanelError('Could not load that bucket. Check your connection and try again.')
    } finally {
      setLoadingDetail(false)
    }
  }

  function openNew() {
    setEditing({ id: null }); setPanelError(''); setSuccess(''); setAddClientId('')
    setFields(EMPTY_FIELDS); setMembers([]); setUses(NO_USES)
    setOriginal(snapshot(EMPTY_FIELDS, []))
  }

  const close = useCallback(() => {
    if (dirty && !confirm('Discard your changes to this bucket?')) return
    setEditing(null)
  }, [dirty])

  function addMember(id: string) {
    const picked = clientLookup.options.find(o => o.id === id)
    setAddClientId('')
    if (!picked || members.some(m => m.id === picked.id)) return
    setMembers([...members, { id: picked.id, name: picked.label }].sort((a, b) => a.name.localeCompare(b.name)))
  }

  async function save() {
    if (!editing) return
    if (!fields.name.trim()) { setPanelError('Give the bucket a name.'); return }
    setBusy(true); setPanelError('')
    try {
      let id = editing.id
      if (id === null) {
        const d = await fetch('/api/tmc/buckets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
        }).then(r => r.json())
        if (!d.ok) { setPanelError(d.error || 'Could not create the bucket.'); return }
        id = d.bucket.id as string
        setEditing({ id })
        setOriginal(snapshot(fields, []))
      }
      // Membership is sent whole: the editor holds the complete list, and a
      // whole-list write cannot half-apply if two admins edit the same bucket.
      if (editing.id !== null || members.length > 0) {
        const d = await fetch(`/api/tmc/buckets/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...fields, clientIds: members.map(m => m.id) }),
        }).then(r => r.json())
        if (!d.ok) { setPanelError(d.error || 'Could not save the bucket.'); return }
      }
      setSuccess(editing.id === null ? `Bucket "${fields.name.trim()}" created.` : `Bucket "${fields.name.trim()}" saved.`)
      setEditing(null)
      list.refetch()
    } catch {
      setPanelError('Could not save. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!editing?.id || !confirm(`Delete the bucket "${fields.name}"?`)) return
    setBusy(true); setPanelError('')
    try {
      const d = await fetch(`/api/tmc/buckets/${editing.id}`, { method: 'DELETE' }).then(r => r.json())
      if (!d.ok) { setPanelError(d.error || 'Could not delete the bucket.'); return }
      setSuccess(`Bucket "${fields.name}" deleted.`)
      setEditing(null)
      list.refetch()
    } catch {
      setPanelError('Could not delete. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  // Already-added clients are hidden from the picker.
  const pickable = clientLookup.options.filter(o => !members.some(m => m.id === o.id))
  const usesCount = uses.dealCodes.length + uses.fops.length + uses.commercialRules.length
  const searching = Boolean(list.search) || Boolean(usedBy)

  return (
    <div>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Buckets</h1>
          <p style={s.sub}>
            Curated sets of clients that deal codes, forms of payment and commercial rules are assigned to,
            instead of client by client. Not a{' '}
            <a href="/tmc/configurations/client-groups" style={s.inlineLink}>client group</a>: a group is the
            client&rsquo;s own org hierarchy and a client has one; a client can be in any number of buckets.
          </p>
        </div>
        <button type="button" onClick={openNew} style={s.primaryBtn}>New bucket</button>
      </div>

      {success && <div style={s.successBanner}>{success}</div>}
      {list.error && <div style={s.errorBanner}>{list.error}</div>}

      <div style={s.filters}>
        <input
          value={list.search}
          onChange={e => list.setSearch(e.target.value)}
          placeholder="Search name or code"
          style={{ ...s.input, flex: 2, minWidth: 200 }}
        />
        <select value={usedBy} onChange={e => setUsedBy(e.target.value)} style={{ ...s.input, flex: 1, minWidth: 180 }}>
          {USED_BY_FILTERS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      {list.loading ? (
        <SkeletonTable rows={8} cols={6} />
      ) : list.items.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>{searching ? 'No buckets match' : 'No buckets yet'}</div>
          <p style={s.emptyDesc}>
            {searching
              ? 'Try another search or filter.'
              : 'Create one, then assign deal codes, payment methods or commercial rules to it instead of client by client.'}
          </p>
        </div>
      ) : (
        <div style={{ ...s.tableWrap, ...(list.refreshing ? s.dimmed : {}) }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Bucket</th>
                <th style={s.th}>Scope</th>
                <th style={s.th}>Clients</th>
                <th style={s.th}>Used by</th>
                <th style={s.th}>Updated</th>
                <th style={{ ...s.th, textAlign: 'right' }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.items.map((b, i) => (
                <tr
                  key={b.id}
                  onClick={() => openBucket(b.id)}
                  style={{ ...s.tr, background: editing?.id === b.id ? '#F5F6FF' : i % 2 ? '#FAFAFA' : '#fff', cursor: 'pointer' }}
                >
                  <td style={s.td}>
                    <div style={s.name}>{b.name}</div>
                    {b.code && <span style={{ ...s.code, marginTop: 4, display: 'inline-block' }}>{b.code}</span>}
                  </td>
                  <td style={{ ...s.td, whiteSpace: 'normal', maxWidth: 320 }}>
                    {b.description
                      ? <span style={s.clamp}>{b.description}</span>
                      : <span style={s.muted}>—</span>}
                  </td>
                  <td style={s.td}>
                    {b.clientCount === 0 ? (
                      <span style={s.muted}>No clients</span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ display: 'flex' }} title={b.memberPreview.join(', ')}>
                          {b.memberPreview.map((n, k) => (
                            <span key={n + k} style={{ ...s.avatar, marginLeft: k ? -6 : 0, background: AVATAR[k % AVATAR.length] }}>
                              {initials(n)}
                            </span>
                          ))}
                        </div>
                        <span>{plural(b.clientCount, 'client', 'clients')}</span>
                      </div>
                    )}
                  </td>
                  <td style={s.td}>
                    <UsedBy deal={b.dealCodeCount} fop={b.fopCount} rule={b.ruleCount} />
                  </td>
                  <td style={s.td}>
                    <div style={s.dates}>{when(b.updated_at)}</div>
                    {b.updated_by_name && <div style={s.by}>{b.updated_by_name}</div>}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right' }}>
                    <button type="button" onClick={e => { e.stopPropagation(); openBucket(b.id) }} style={s.ghostBtn}>
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={list.page} pageSize={10} total={list.total} onPageChange={list.setPage} busy={list.refreshing} noun="buckets" />

      <SlideOver
        open={editing !== null}
        onClose={close}
        title={editing?.id === null ? 'New bucket' : <>{fields.name || 'Bucket'}{fields.code && <span style={s.code}>{fields.code}</span>}</>}
        subtitle={editing?.id && !loadingDetail
          ? usesCount === 0
            ? 'Nothing is assigned through this bucket yet.'
            : `Changes to its clients apply to the ${[
                uses.dealCodes.length && plural(uses.dealCodes.length, 'deal code', 'deal codes'),
                uses.fops.length && plural(uses.fops.length, 'payment method', 'payment methods'),
                uses.commercialRules.length && plural(uses.commercialRules.length, 'commercial rule', 'commercial rules'),
              ].filter((x): x is string => Boolean(x)).reduce((acc, x, i, all) => acc + (i === 0 ? '' : i === all.length - 1 ? ' and ' : ', ') + x, '')} assigned through it, on bookings priced from now on.`
          : undefined}
        footer={
          <>
            <button type="button" onClick={save} disabled={busy || loadingDetail || (!dirty && editing?.id !== null)}
              style={{ ...s.primaryBtn, opacity: busy || loadingDetail || (!dirty && editing?.id !== null) ? 0.5 : 1 }}>
              {busy ? 'Saving…' : editing?.id === null ? 'Create bucket' : 'Save changes'}
            </button>
            <button type="button" onClick={close} style={s.ghostBtn}>Cancel</button>
            {editing?.id && (
              <button type="button" onClick={remove} disabled={busy} style={{ ...s.dangerBtn, marginLeft: 'auto' }}>Delete</button>
            )}
          </>
        }
      >
        {panelError && <div style={s.errorBanner}>{panelError}</div>}

        {loadingDetail ? (
          <SkeletonTable rows={5} cols={2} />
        ) : (
          <>
            <div style={{ ...s.sectionLabel, marginTop: 0 }}>Details</div>
            <div style={s.row}>
              <div style={{ ...s.field, flex: 2 }}>
                <label style={s.label}>Name</label>
                <input value={fields.name} onChange={e => setFields({ ...fields, name: e.target.value })}
                  placeholder="Tier 1 corporates" style={s.input} />
              </div>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>Code</label>
                <input value={fields.code} onChange={e => setFields({ ...fields, code: e.target.value.toUpperCase() })}
                  placeholder="Optional" style={{ ...s.input, ...s.mono }} />
              </div>
            </div>
            <div style={s.field}>
              <label style={s.label}>Scope</label>
              <textarea value={fields.description} onChange={e => setFields({ ...fields, description: e.target.value })}
                placeholder="Who belongs in this bucket, and why" rows={2} style={s.textarea} />
            </div>

            <div style={s.sectionLabel}>Clients · {members.length}</div>
            <SearchableSelect
              value={addClientId}
              onChange={addMember}
              options={pickable}
              onSearch={clientLookup.onSearch}
              loading={clientLookup.loading}
              selectedLabel={clientLookup.selectedLabel}
              placeholder="Search clients to add…"
              emptyMessage="No more clients match"
            />
            {members.length === 0 ? (
              <p style={s.hint}>No clients yet. Search above to add them.</p>
            ) : (
              <div style={s.memberList}>
                {members.map((m, i) => (
                  <div key={m.id} style={s.member}>
                    <span style={{ ...s.avatar, background: AVATAR[i % AVATAR.length] }}>{initials(m.name)}</span>
                    <span style={{ flex: 1, minWidth: 0, color: 'var(--color-ink)', fontWeight: 500 }}>{m.name}</span>
                    {m.status && m.status !== 'active' && <span style={s.inactivePill}>Inactive</span>}
                    <button type="button" onClick={() => setMembers(members.filter(x => x.id !== m.id))}
                      aria-label={`Remove ${m.name}`} title={`Remove ${m.name}`} style={s.removeBtn}>×</button>
                  </div>
                ))}
              </div>
            )}

            {editing?.id && (
              <>
                <div style={s.sectionLabel}>Used by</div>
                {usesCount === 0 ? (
                  <p style={s.hint}>
                    Nothing yet. Assign this bucket from a deal code, a payment method&rsquo;s mapping, or a commercial rule.
                  </p>
                ) : (
                  <>
                    <UseGroup title="Deal codes" href="/tmc/configurations/deal-codes"
                      items={uses.dealCodes.map(c => ({ id: c.id, label: `${c.airline_code} · ${c.code}`, note: c.code_type }))} />
                    <UseGroup title="Payment methods" href="/tmc/configurations/forms-of-payment?tab=mapping"
                      items={uses.fops.map(f => ({ id: f.id, label: f.label, note: f.payer }))} />
                    <UseGroup title="Commercial rules" href={RULE_KIND[uses.commercialRules[0]?.kind]?.href ?? '/tmc/configurations/markup'}
                      items={uses.commercialRules.map(r => ({ id: r.id, label: ruleLabel(r), note: r.active ? undefined : 'inactive' }))} />
                    <p style={s.hint}>Assignments are changed where they are made, not here.</p>
                  </>
                )}
              </>
            )}
          </>
        )}
      </SlideOver>
    </div>
  )
}

function UsedBy({ deal, fop, rule }: { deal: number; fop: number; rule: number }) {
  const chips = [
    deal > 0 && plural(deal, 'deal code', 'deal codes'),
    fop > 0 && plural(fop, 'payment method', 'payment methods'),
    rule > 0 && plural(rule, 'commercial rule', 'commercial rules'),
  ].filter(Boolean) as string[]
  if (chips.length === 0) return <span style={s.muted}>Not used yet</span>
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {chips.map(c => <span key={c} style={s.usePill}>{c}</span>)}
    </div>
  )
}

function UseGroup({ title, href, items }: { title: string; href: string; items: { id: string; label: string; note?: string }[] }) {
  if (items.length === 0) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={s.useHead}>
        <span>{title}</span>
        <a href={href} style={s.inlineLink}>Open</a>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {items.map(it => (
          <span key={it.id} style={s.useChip}>
            {it.label}
            {it.note && <span style={{ color: 'var(--color-secondary)' }}>{it.note}</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

// Neutral avatar tints from the palette the masters already use.
const AVATAR = ['#000835', '#3730A3', '#475569', '#0F766E']

const s: Record<string, React.CSSProperties> = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: 'var(--color-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 660 },
  inlineLink: { color: 'var(--color-rail)', fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 2 },

  filters: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 7, outline: 'none', width: '100%', boxSizing: 'border-box' },
  textarea: { padding: '8px 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 7, outline: 'none', width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' },
  mono: { fontFamily: 'var(--font-mono)' },

  tableWrap: { background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { padding: '10px 14px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid var(--color-line)', fontSize: 11, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #F3F4F6' },
  td: { padding: '10px 14px', fontSize: 13, color: 'var(--color-body)', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  name: { fontWeight: 500, color: 'var(--color-ink)' },
  clamp: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 12.5, lineHeight: 1.45 },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },
  muted: { color: '#9CA3AF' },
  dates: { fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--color-body)' },
  by: { fontSize: 11.5, color: 'var(--color-secondary)', marginTop: 2 },
  code: { fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 600, color: '#111827', background: '#F3F4F6', borderRadius: 4, padding: '2px 7px' },
  avatar: { width: 24, height: 24, borderRadius: '50%', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #fff', flexShrink: 0, letterSpacing: '0.02em' },
  usePill: { fontSize: 11, fontWeight: 600, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '2px 7px' },

  empty: { background: '#fff', border: '1px dashed var(--color-line-strong)', borderRadius: 10, padding: '28px 22px', textAlign: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: 600, color: 'var(--color-ink)' },
  emptyDesc: { fontSize: 12, color: 'var(--color-secondary)', margin: '6px 0 0' },

  sectionLabel: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--color-secondary)', margin: '18px 0 10px', paddingBottom: 5, borderBottom: '1px solid var(--color-line)' },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  row: { display: 'flex', gap: 10, alignItems: 'flex-end' },
  hint: { fontSize: 12, color: 'var(--color-secondary)', margin: '8px 0 0', lineHeight: 1.5 },

  memberList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 },
  member: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', background: '#F9FAFB', borderRadius: 7, fontSize: 13 },
  inactivePill: { fontSize: 10.5, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', border: '1px solid #E5E7EB', borderRadius: 999, padding: '1px 8px' },
  removeBtn: { width: 24, height: 24, border: 'none', background: 'transparent', color: '#9CA3AF', fontSize: 16, lineHeight: 1, cursor: 'pointer', borderRadius: 5 },

  useHead: { display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 6 },
  useChip: { display: 'inline-flex', gap: 6, alignItems: 'center', background: '#fff', border: '1px solid var(--color-line-strong)', borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--color-body)' },

  primaryBtn: { height: 32, padding: '0 14px', background: 'var(--color-rail)', color: '#fff', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer' },
  ghostBtn: { height: 30, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 12, border: '1px solid var(--color-line-strong)', borderRadius: 6, cursor: 'pointer' },
  dangerBtn: { height: 32, padding: '0 12px', background: '#fff', color: '#DC2626', fontSize: 12, border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', borderRadius: 8, padding: '10px 14px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#065F46', borderRadius: 8, padding: '10px 14px', fontSize: 12, marginBottom: 14 },
}
