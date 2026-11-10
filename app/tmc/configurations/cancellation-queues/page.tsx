'use client'

import { useState } from 'react'
import Link from 'next/link'
import Tabs, { useUrlTab } from '@/app/components/Tabs'
import Pagination from '@/app/components/Pagination'
import SearchableSelect from '@/app/components/SearchableSelect'
import SlideOver from '@/app/components/SlideOver'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import { useLookup } from '@/app/hooks/useLookup'
import { s, STATE_META, money, dateOnly, dateTime, type QueueState } from './ui'

// ── Configurations → Queues → Cancellation queues ────────────────────────────
// Every cancelled ticket waiting on the desk, and each client's refund rule.
//
//   Queue          one row per ticket: awaiting the airline's confirmation
//                  first ("Mark cancelled"), then refunds to process, then the
//                  settled ones. "Process refund" opens the refund panel.
//   Refund rules   per client: whether markup and the processing fee go
//                  back, the TMC's cancellation fee, the GST rate. The same
//                  setting as the client's Corporate Settings → Refunds.
//
// Data: GET /api/tmc/queues/refunds and /api/tmc/queues/refund-rules.
// ─────────────────────────────────────────────────────────────────────────────

interface QueueRow {
  id: string
  state: QueueState
  booking_id: string
  reference: string | null
  client_name: string
  group_name: string | null
  pnr: string | null
  airline_pnr: string | null
  first_name: string | null
  last_name: string | null
  pax_type: string | null
  origin: string | null
  destination: string | null
  departure: string | null
  airline: string | null
  ticket_number: string | null
  paid: number | null
  refund_amount: number | null
  credit_note_no: string | null
  requested_at: string | null
  requested_by: string | null
  requested_by_kind: 'traveller' | 'desk' | 'admin' | null
}

interface RuleRow {
  id: string
  name: string
  client_code: string | null
  group_name: string | null
  refund_markup: boolean
  refund_processing_fee: boolean
  tmc_cancellation_fee: number
  tmc_cancellation_fee_unit: 'amount' | 'percent'
  gst_rate: number
  pending: number
}

const TABS = ['queue', 'rules'] as const
type Tab = typeof TABS[number]

const KIND_LABEL = { traveller: 'Traveller', desk: 'Desk', admin: 'Company admin' } as const

export default function CancellationQueuesPage() {
  const [tab, setTab] = useUrlTab<Tab>('tab', 'queue', TABS)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // ── Queue filters ──────────────────────────────────────────────────────────
  const [state, setState] = useState<'' | QueueState>('')
  const [clientId, setClientId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [more, setMore] = useState(false)
  const [depFrom, setDepFrom] = useState('')
  const [depTo, setDepTo] = useState('')
  const [airline, setAirline] = useState('')
  const [source, setSource] = useState('')

  const queue = usePagedList<QueueRow>('/api/tmc/queues/refunds', {
    params: { state, clientId, from, to, depFrom, depTo, airline: airline.length === 2 ? airline : '', source },
    enabled: tab === 'queue',
  })
  const rules = usePagedList<RuleRow>('/api/tmc/queues/refund-rules', { enabled: tab === 'rules' })

  const clientLookup = useLookup('/api/tmc/clients', clientId, {
    toOption: row => ({ id: String(row.id), label: String(row.name), sublabel: row.client_code ? String(row.client_code) : undefined }),
  })

  async function markCancelled(row: QueueRow) {
    if (!confirm(`Has the airline confirmed the cancellation of ${row.pnr ?? 'this booking'}?\n\nIts tickets' refunds can be processed once it is marked cancelled.`)) return
    setError(''); setSuccess('')
    const res = await fetch(`/api/tmc/queues/cancellations/${row.booking_id}/mark-cancelled`, { method: 'POST' })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d.error || 'Could not mark it cancelled.'); return }
    setSuccess(`${row.pnr ?? 'The booking'} is marked cancelled; its refunds are ready to process.`)
    queue.refetch()
  }

  // ── Refund rule editing ────────────────────────────────────────────────────
  const [editing, setEditing] = useState<RuleRow | null>(null)
  const [saving, setSaving] = useState(false)
  async function saveRule() {
    if (!editing) return
    setSaving(true); setError(''); setSuccess('')
    try {
      const res = await fetch(`/api/tmc/clients/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refund_markup: editing.refund_markup,
          refund_processing_fee: editing.refund_processing_fee,
          tmc_cancellation_fee: Number(editing.tmc_cancellation_fee) || 0,
          tmc_cancellation_fee_unit: editing.tmc_cancellation_fee_unit,
          gst_rate: Number(editing.gst_rate) || 0,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not save the refund rule.'); return }
      setSuccess(`Refund rule saved for ${editing.name}.`)
      setEditing(null)
      rules.refetch()
    } finally { setSaving(false) }
  }

  const passenger = (r: QueueRow) => [r.first_name, r.last_name].filter(Boolean).join(' ') || '—'

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Cancellation queues</h1>
          <p style={s.sub}>
            Every cancelled ticket, and what the company gets back. Each ticket is refunded on its own,
            with a credit note. The airline&apos;s charges come from its cancellation; the rest follows the
            client&apos;s refund rule, and every line can be adjusted before processing.
          </p>
        </div>
      </div>

      <Tabs<Tab>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'queue', label: 'Queue', count: queue.total || undefined },
          { id: 'rules', label: 'Refund rules' },
        ]}
      />

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      {tab === 'queue' && (
        <>
          <div style={s.filters}>
            <input
              value={queue.search} onChange={e => queue.setSearch(e.target.value)}
              placeholder="PNR, ticket, passenger, credit note…" style={{ ...s.input, flex: 2, minWidth: 220 }}
            />
            <select value={state} onChange={e => setState(e.target.value as '' | QueueState)} style={{ ...s.input, flex: 1, minWidth: 160 }}>
              <option value="">Status: All</option>
              {(Object.keys(STATE_META) as QueueState[]).map(k => <option key={k} value={k}>{STATE_META[k].label}</option>)}
            </select>
            <div style={{ flex: 1.5, minWidth: 200 }}>
              <SearchableSelect
                value={clientId} onChange={setClientId}
                options={clientLookup.options} onSearch={clientLookup.onSearch} loading={clientLookup.loading}
                selectedLabel={clientLookup.selectedLabel} placeholder="Client: All" emptyMessage="No clients match" allowClear
              />
            </div>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={s.input} aria-label="Cancelled from" title="Cancelled from" />
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={s.input} aria-label="Cancelled to" title="Cancelled to" />
            <button type="button" onClick={() => setMore(m => !m)} style={s.ghostBtn}>{more ? 'Fewer filters' : 'More filters'}</button>
          </div>
          {more && (
            <div style={s.filters}>
              <label style={{ ...s.hint, margin: 0 }}>Departing</label>
              <input type="date" value={depFrom} onChange={e => setDepFrom(e.target.value)} style={s.input} aria-label="Departing from" />
              <input type="date" value={depTo} onChange={e => setDepTo(e.target.value)} style={s.input} aria-label="Departing to" />
              <input
                value={airline} onChange={e => setAirline(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="Airline (e.g. AI)" style={{ ...s.input, width: 130 }}
              />
              <select value={source} onChange={e => setSource(e.target.value)} style={s.input}>
                <option value="">Booked by: Anyone</option>
                <option value="self">The traveller</option>
                <option value="desk">The travel desk</option>
                <option value="colleague">A colleague</option>
              </select>
            </div>
          )}

          {queue.loading ? (
            <SkeletonTable rows={8} cols={10} />
          ) : queue.items.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyTitle}>{queue.search || state || clientId ? 'Nothing matches these filters' : 'No cancelled tickets'}</p>
              <p style={s.emptyDesc}>
                When a ticketed booking is cancelled, each of its tickets appears here for its refund.
              </p>
            </div>
          ) : (
            <div style={{ ...s.tableWrap, ...(queue.refreshing ? s.dimmed : {}) }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Cancelled', 'Passenger', 'Client', 'Journey', 'PNR', 'Ticket', 'Paid', 'Status', ''].map(h => (
                      <th key={h} style={{ ...s.th, ...(h === 'Paid' ? s.num : {}) }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queue.items.map((r, i) => {
                    const meta = STATE_META[r.state]
                    return (
                      <tr key={r.id} style={{ ...s.tr, background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                        <td style={s.td}>
                          {dateTime(r.requested_at)}
                          <span style={s.tdSub}>
                            {r.requested_by_kind ? KIND_LABEL[r.requested_by_kind] : ''}{r.requested_by ? `: ${r.requested_by}` : ''}
                          </span>
                        </td>
                        <td style={s.td}>{passenger(r)}<span style={s.tdSub}>{r.pax_type ?? ''}</span></td>
                        <td style={s.td}>{r.client_name}<span style={s.tdSub}>{r.group_name ?? ''}</span></td>
                        <td style={s.td}>
                          {[r.origin, r.destination].filter(Boolean).join(' → ') || '—'}
                          <span style={s.tdSub}>{dateOnly(r.departure)}{r.airline ? ` · ${r.airline}` : ''}</span>
                        </td>
                        <td style={s.td}>
                          <span style={s.code}>{r.pnr ?? '—'}</span>
                          {r.airline_pnr && r.airline_pnr !== r.pnr && <span style={s.tdSub}>Airline {r.airline_pnr}</span>}
                        </td>
                        <td style={{ ...s.td, ...s.mono, fontSize: 12 }}>{r.ticket_number ?? '—'}</td>
                        <td style={{ ...s.td, ...s.num }}>
                          {money(r.paid)}
                          {r.state === 'processed' && <span style={s.tdSub}>Refunded {money(r.refund_amount)}</span>}
                        </td>
                        <td style={s.td}>
                          <span style={{ ...s.pill, color: meta.color, background: meta.bg }}>{meta.label}</span>
                          {r.credit_note_no && <span style={{ ...s.tdSub, ...s.mono }}>{r.credit_note_no}</span>}
                        </td>
                        <td style={{ ...s.td, textAlign: 'right' }}>
                          {r.state === 'cancel_requested' ? (
                            <button type="button" onClick={() => markCancelled(r)} style={s.ghostBtn}>Mark cancelled</button>
                          ) : (
                            <Link
                              href={`/tmc/configurations/cancellation-queues/${r.id}`}
                              style={r.state === 'pending' ? s.primaryBtn : s.ghostBtn}
                            >
                              {r.state === 'pending' ? 'Process refund' : 'View'}
                            </Link>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            page={queue.page} pageSize={10} total={queue.total}
            onPageChange={queue.setPage} busy={queue.refreshing} noun="tickets"
          />
        </>
      )}

      {tab === 'rules' && (
        <>
          <p style={{ ...s.hint, marginBottom: 14, maxWidth: 680 }}>
            Where every refund starts from, per client. Also on each client&apos;s Corporate Settings → Refunds:
            change it in either place.
          </p>
          <div style={s.filters}>
            <input
              value={rules.search} onChange={e => rules.setSearch(e.target.value)}
              placeholder="Search client name or code" style={{ ...s.input, flex: 1, minWidth: 220, maxWidth: 360 }}
            />
          </div>
          {rules.loading ? (
            <SkeletonTable rows={8} cols={6} />
          ) : rules.items.length === 0 ? (
            <div style={s.empty}><p style={s.emptyTitle}>No clients match</p></div>
          ) : (
            <div style={{ ...s.tableWrap, ...(rules.refreshing ? s.dimmed : {}) }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Client', 'Markup', 'Processing fee', 'TMC cancellation fee', 'GST', 'Waiting', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rules.items.map((r, i) => (
                    <tr key={r.id} style={{ ...s.tr, background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                      <td style={s.td}>
                        {r.name}
                        <span style={s.tdSub}>{[r.client_code, r.group_name].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td style={s.td}>{r.refund_markup ? 'Refunded' : 'Kept'}</td>
                      <td style={s.td}>{r.refund_processing_fee ? 'Refunded' : 'Kept'}</td>
                      <td style={s.td}>
                        {Number(r.tmc_cancellation_fee) === 0
                          ? 'None'
                          : r.tmc_cancellation_fee_unit === 'percent' ? `${Number(r.tmc_cancellation_fee)}% of what was paid` : `${money(r.tmc_cancellation_fee)} per ticket`}
                      </td>
                      <td style={s.td}>{Number(r.gst_rate)}%</td>
                      <td style={{ ...s.td, ...s.num }}>{r.pending || '—'}</td>
                      <td style={{ ...s.td, textAlign: 'right' }}>
                        <button type="button" onClick={() => setEditing({ ...r })} style={s.ghostBtn}>Edit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            page={rules.page} pageSize={10} total={rules.total}
            onPageChange={rules.setPage} busy={rules.refreshing} noun="clients"
          />
        </>
      )}

      <SlideOver
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `Refund rule: ${editing.name}` : ''}
        subtitle="Where every refund for this client starts. The desk can still change any line of a single refund."
        footer={
          <>
            <button type="button" onClick={saveRule} disabled={saving} style={s.primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={() => setEditing(null)} style={s.ghostBtn}>Cancel</button>
          </>
        }
      >
        {editing && (
          <>
            {([
              ['refund_markup', 'Refund the markup', 'Off: the TMC keeps its markup on a cancelled ticket.'],
              ['refund_processing_fee', 'Refund the processing fee', 'Off: the TMC keeps its processing fee.'],
            ] as const).map(([key, label, note]) => (
              <label key={key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 14, cursor: 'pointer' }}>
                <input
                  type="checkbox" checked={editing[key]}
                  onChange={e => setEditing({ ...editing, [key]: e.target.checked })}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>{label}</span>
                  <span style={s.hint}>{note}</span>
                </span>
              </label>
            ))}
            <div style={s.field}>
              <span style={s.label}>TMC cancellation fee</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="number" min={0} step="any" value={editing.tmc_cancellation_fee}
                  onChange={e => setEditing({ ...editing, tmc_cancellation_fee: e.target.value === '' ? 0 : Number(e.target.value) })}
                  style={{ ...s.input, flex: 1 }}
                />
                <select
                  value={editing.tmc_cancellation_fee_unit}
                  onChange={e => setEditing({ ...editing, tmc_cancellation_fee_unit: e.target.value as 'amount' | 'percent' })}
                  style={{ ...s.input, width: 170 }}
                >
                  <option value="amount">₹ per ticket</option>
                  <option value="percent">% of what was paid</option>
                </select>
              </div>
              <span style={s.hint}>On top of the airline&apos;s own charges. 0: none.</span>
            </div>
            <div style={s.field}>
              <span style={s.label}>GST rate on TMC charges</span>
              <input
                type="number" min={0} max={100} step="any" value={editing.gst_rate}
                onChange={e => setEditing({ ...editing, gst_rate: e.target.value === '' ? 0 : Number(e.target.value) })}
                style={{ ...s.input, width: 120 }}
              />
              <span style={s.hint}>Applied to the TMC cancellation fee: CGST + SGST in the same state, IGST across states.</span>
            </div>
          </>
        )}
      </SlideOver>
    </div>
  )
}
