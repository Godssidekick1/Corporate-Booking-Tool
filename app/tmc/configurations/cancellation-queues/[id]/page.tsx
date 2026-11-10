'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  computeRefund, type RefundComputation, type RefundInputs, type RefundRule, type DeductionKey, type LineSource,
} from '@/app/lib/refunds/compute'
import { s, STATE_META, MODE_LABELS, money, dateOnly, dateTime, type QueueState } from '../ui'
import CreditNote, { type Parties } from './CreditNote'

// ── The refund panel ─────────────────────────────────────────────────────────
// One cancelled ticket: what it cost, what is kept back, what goes back.
//
//   Fare paid     read-only: the airline's fare and taxes, seat fees, the
//                 TMC's markup and fee, the discount (section A)
//   Deductions    editable: each prefilled from the airline's cancellation
//                 or the client's refund rule, tagged with where it came from;
//                 "reset" puts the default back (sections B and C)
//   Summary       refund to the company, expected from the airline, what the
//                 TMC keeps; refund date, how it is paid back, a remark,
//                 documents; Process or Reject (section D)
//
// Recomputed in the browser as a line is edited (app/lib/refunds/compute.ts,
// pure), and again by the server when processing; only the server's result
// is stored. A processed refund is read-only, with its printable credit note.
// ─────────────────────────────────────────────────────────────────────────────

interface Attachment { id: string; filename: string; size: number; uploaded_at: string; uploaded_by_name: string | null }

interface PanelData {
  refund: {
    id: string; status: 'pending' | 'processed' | 'rejected'; awaitingConfirmation: boolean; canProcess: boolean
    bookingId: string; clientName: string; clientCode: string | null; creditNoteNo: string | null
    refundAmount: number | null; refundDate: string | null; mode: string; remark: string | null
    processedBy: string | null; processedAt: string | null; rejectedReason: string | null
  }
  ticket: {
    passenger: string | null; paxType: string | null; pnr: string | null; airlinePnr: string | null; ticketNumber: string | null
    reference: string | null; sector: string | null; departure: string | null; airline: { code: string; name: string } | null
    flights: string[]; cabin: string | null; rbd: string | null; bookedAt: string; cancelledAt: string | null
    cancelledBy: string | null; cancellationReason: string | null; providerStatus: string | null
  }
  computation: RefundComputation
  overrides: Partial<Record<DeductionKey, number>>
  inputs: RefundInputs
  rule: RefundRule
  sameState: boolean | null
  attachments: Attachment[]
  parties: Parties | null
}

const SOURCE_TAG: Record<LineSource, string> = {
  booking: 'booking', airline: 'from airline', rule: 'client rule', computed: 'computed', edited: 'edited',
}

const today = () => new Date().toISOString().slice(0, 10)

export default function RefundPanelPage() {
  const { id } = useParams() as { id: string }
  const [data, setData] = useState<PanelData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const [overrides, setOverrides] = useState<Partial<Record<DeductionKey, number>>>({})
  const [refundDate, setRefundDate] = useState(today())
  const [mode, setMode] = useState('agency_credit')
  const [remark, setRemark] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const apply = useCallback((r: { ok: boolean; d: PanelData & { error?: string } }) => {
    if (!r.ok) { setLoadError(r.d.error || 'Could not load this refund.'); return }
    setData(r.d)
    setOverrides(r.d.overrides ?? {})
    setMode(r.d.refund.mode ?? 'agency_credit')
    setRemark(r.d.refund.remark ?? '')
    setRefundDate(r.d.refund.refundDate ?? today())
  }, [])

  const fetchPanel = useCallback(() =>
    fetch(`/api/tmc/queues/refunds/${id}`)
      .then(async res => ({ ok: res.ok, d: await res.json().catch(() => ({})) })), [id])

  const load = useCallback(() => fetchPanel().then(apply), [fetchPanel, apply])

  useEffect(() => {
    let alive = true
    fetchPanel().then(r => { if (alive) apply(r) })
    return () => { alive = false }
  }, [fetchPanel, apply])

  const editable = data?.refund.status === 'pending'

  // Live while pending; the stored record once settled.
  const live = useMemo<{ c: RefundComputation | null; error: string }>(() => {
    if (!data) return { c: null, error: '' }
    if (!editable) return { c: data.computation, error: '' }
    try {
      return { c: computeRefund(data.inputs, data.rule, data.sameState, overrides), error: '' }
    } catch (e) {
      return { c: data.computation, error: e instanceof Error ? e.message : 'Check the amounts.' }
    }
  }, [data, editable, overrides])

  function setLine(key: DeductionKey, raw: string) {
    setOverrides(prev => {
      const next = { ...prev }
      if (raw === '') delete next[key]
      else next[key] = Number(raw)
      return next
    })
  }
  function resetLine(key: DeductionKey) {
    setOverrides(prev => { const next = { ...prev }; delete next[key]; return next })
  }

  async function post(path: string, body?: unknown) {
    setBusy(true); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/tmc/queues/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'That did not go through.'); return null }
      return d
    } finally { setBusy(false) }
  }

  async function processRefund() {
    if (!data || !live.c) return
    if (!confirm(`Issue a credit note for ${money(live.c.result.refundAmount)} to ${data.refund.clientName}?\n\nThe refund is final once processed.`)) return
    const d = await post(`refunds/${id}/process`, { overrides, refundDate, mode, remark: remark.trim() || undefined })
    if (d) { setNotice(`Processed: credit note ${d.creditNoteNo} for ${money(d.refundAmount)}.`); await load() }
  }

  async function rejectRefund() {
    const d = await post(`refunds/${id}/reject`, { reason: rejectReason.trim() })
    if (d) { setRejecting(false); setNotice('Refund rejected.'); await load() }
  }

  async function markCancelled() {
    if (!data || !confirm('Has the airline confirmed this cancellation?')) return
    const d = await post(`cancellations/${data.refund.bookingId}/mark-cancelled`)
    if (d) { setNotice('Marked cancelled: the refund can be processed now.'); await load() }
  }

  async function upload(file: File) {
    setBusy(true); setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/tmc/queues/refunds/${id}/attachments`, { method: 'POST', body: form })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not upload the file.'); return }
      await load()
    } finally { setBusy(false) }
  }

  async function removeAttachment(aid: string) {
    if (!confirm('Remove this document?')) return
    const res = await fetch(`/api/tmc/queues/refunds/${id}/attachments/${aid}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Could not remove it.'); return }
    await load()
  }

  if (loadError) return <div style={s.root}><p style={s.errorBanner}>{loadError}</p><Back /></div>
  if (!data || !live.c) return <div style={s.root}><p style={s.hint}>Loading…</p></div>

  const { refund, ticket } = data
  const c = live.c
  const state: QueueState = refund.status === 'pending' && refund.awaitingConfirmation ? 'cancel_requested' : refund.status
  const meta = STATE_META[state]

  return (
    <div style={s.root}>
      <Back />
      <div style={{ ...s.header, marginTop: 8 }}>
        <div>
          <h1 style={s.title}>Refund · {ticket.passenger ?? 'Passenger'}</h1>
          <p style={s.sub}>{refund.clientName}{refund.clientCode ? ` (${refund.clientCode})` : ''}</p>
        </div>
        <div style={s.actions}>
          <span style={{ ...s.pill, color: meta.color, background: meta.bg }}>{meta.label}</span>
          {refund.creditNoteNo && <span style={s.code}>{refund.creditNoteNo}</span>}
        </div>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {notice && <div style={s.successBanner}>{notice}</div>}
      {live.error && <div style={s.errorBanner}>{live.error}</div>}
      {c.warnings.map(w => <div key={w} style={s.warnBanner}>{w}</div>)}
      {refund.awaitingConfirmation && (
        <div style={{ ...s.warnBanner, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>The airline accepted this cancellation but has not confirmed it. Mark it cancelled once it has; then the refund can be processed.</span>
          <button type="button" onClick={markCancelled} disabled={busy} style={s.ghostBtn}>Mark cancelled</button>
        </div>
      )}
      {refund.status === 'rejected' && (
        <div style={s.errorBanner}>Rejected by {refund.processedBy ?? '—'} on {dateTime(refund.processedAt)}: “{refund.rejectedReason}”</div>
      )}

      {/* ── Ticket ─────────────────────────────────────────────────────────── */}
      <section style={p.card}>
        <dl style={p.facts}>
          {([
            ['Passenger', [ticket.passenger, ticket.paxType].filter(Boolean).join(' · ')],
            ['GDS PNR', ticket.pnr], ['Airline PNR', ticket.airlinePnr], ['Ticket', ticket.ticketNumber],
            ['Sector', ticket.sector], ['Departure', dateOnly(ticket.departure)],
            ['Airline', ticket.airline ? `${ticket.airline.name} (${ticket.airline.code})` : null],
            ['Flights', ticket.flights.join(', ')], ['Cabin · RBD', [ticket.cabin, ticket.rbd].filter(Boolean).join(' · ')],
            ['Booked', dateTime(ticket.bookedAt)], ['Cancelled', dateTime(ticket.cancelledAt)],
            ['Cancelled by', ticket.cancelledBy], ['Reason', ticket.cancellationReason], ['Provider status', ticket.providerStatus],
            ['Booking reference', ticket.reference],
          ] as const).map(([k, v]) => (
            <div key={k} style={p.fact}><dt style={p.factK}>{k}</dt><dd style={p.factV}>{v || '—'}</dd></div>
          ))}
        </dl>
      </section>

      <div style={p.columns}>
        {/* ── Left: fare paid, deductions ─────────────────────────────────────── */}
        <div style={p.left}>
          <section style={p.card}>
            <h2 style={p.h2}>Fare paid</h2>
            <table style={p.stmt}>
              <tbody>
                {c.charged.lines.map(l => (
                  <tr key={l.key}>
                    <td style={p.k}>{l.label}</td>
                    <td style={p.v}>{l.amount < 0 ? `− ${money(-l.amount)}` : money(l.amount)}</td>
                  </tr>
                ))}
                {c.charged.k3 > 0 && (
                  <tr><td style={p.sub}>K3 as {data.sameState ? `CGST ${money(c.charged.k3Split.cgst)} + SGST ${money(c.charged.k3Split.sgst)}` : `IGST ${money(c.charged.k3Split.igst)}`}</td><td /></tr>
                )}
                <tr><td style={p.totalK}>Paid for this ticket</td><td style={p.totalV}>{money(c.charged.totalPaid)}</td></tr>
              </tbody>
            </table>
          </section>

          <section style={p.card}>
            <h2 style={p.h2}>Deductions</h2>
            <table style={p.stmt}>
              <tbody>
                {c.deductions.map(d => (
                  <tr key={d.key}>
                    <td style={p.k}>
                      {d.label}
                      <span style={{ ...p.tag, ...(d.source === 'edited' ? p.tagEdited : {}) }}>{SOURCE_TAG[d.source]}</span>
                      {d.key === 'gst_on_tmc_fee' && d.amount > 0 && (
                        <span style={p.subInline}>
                          {data.sameState ? `CGST ${money(c.gst.onTmcFee.cgst)} + SGST ${money(c.gst.onTmcFee.sgst)}` : `IGST ${money(c.gst.onTmcFee.igst)}`} at {c.gst.rate}%
                        </span>
                      )}
                    </td>
                    <td style={p.v}>
                      {editable ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {d.source === 'edited' && (
                            <button type="button" onClick={() => resetLine(d.key)} style={s.linkBtn} title={`Default ${money(d.default)}`}>reset</button>
                          )}
                          <input
                            type="number" min={0} step="any" inputMode="decimal"
                            value={overrides[d.key] ?? d.amount}
                            onChange={e => setLine(d.key, e.target.value)}
                            style={{ ...s.input, width: 120, height: 32, textAlign: 'right' }}
                            aria-label={d.label}
                          />
                        </span>
                      ) : money(d.amount)}
                    </td>
                  </tr>
                ))}
                <tr><td style={p.totalK}>Total kept back</td><td style={p.totalV}>{money(c.result.deductionsTotal)}</td></tr>
              </tbody>
            </table>
          </section>
        </div>

        {/* ── Right: the summary and the decision ─────────────────────────────── */}
        <aside style={p.right}>
          <section style={{ ...p.card, position: 'sticky', top: 16 }}>
            <h2 style={p.h2}>Refund summary</h2>
            <p style={p.bigLabel}>Refund to the company</p>
            <p style={p.big}>{money(c.result.refundAmount)}</p>
            {c.result.roundOff !== 0 && <p style={s.hint}>Rounded from {money(c.result.refundExact)} ({money(c.result.roundOff)})</p>}
            <dl style={{ ...p.facts, gridTemplateColumns: '1fr', marginTop: 12 }}>
              <div style={p.factRow}><dt style={p.factK}>Expected from the airline</dt><dd style={p.factV}>{money(c.result.airlineRefund)}</dd></div>
              <div style={p.factRow}><dt style={p.factK}>TMC keeps</dt><dd style={p.factV}>{money(c.result.tmcRetained)}</dd></div>
            </dl>

            <div style={{ ...s.field, marginTop: 14 }}>
              <span style={s.label}>Refund date</span>
              <input type="date" value={refundDate} max={today()} disabled={!editable} onChange={e => setRefundDate(e.target.value)} style={s.input} />
            </div>
            <div style={s.field}>
              <span style={s.label}>Paid back by</span>
              <select value={mode} disabled={!editable} onChange={e => setMode(e.target.value)} style={s.input}>
                {Object.entries(MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <span style={s.label}>Remark</span>
              <textarea
                value={remark} disabled={!editable} maxLength={1000} rows={3}
                onChange={e => setRemark(e.target.value)}
                style={{ ...s.input, height: 'auto', padding: 8, resize: 'vertical' }}
                placeholder="e.g. Airline refund note attached"
              />
            </div>

            <div style={s.field}>
              <span style={s.label}>Documents</span>
              {data.attachments.length === 0 && <span style={s.hint}>None attached.</span>}
              {data.attachments.map(a => (
                <span key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
                  <a href={`/api/tmc/queues/refunds/${id}/attachments/${a.id}`} style={s.linkBtn}>{a.filename}</a>
                  <span style={{ color: 'var(--color-secondary)' }}>
                    {Math.ceil(a.size / 1024)} KB
                    {editable && <button type="button" onClick={() => removeAttachment(a.id)} style={{ ...s.linkBtn, marginLeft: 8, color: '#DC2626' }}>remove</button>}
                  </span>
                </span>
              ))}
              {refund.status !== 'rejected' && (
                <input
                  type="file" accept="application/pdf,image/jpeg,image/png" disabled={busy}
                  onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
                  style={{ fontSize: 12, marginTop: 4 }}
                />
              )}
              <span style={s.hint}>PDF, JPG or PNG, up to 5 MB.</span>
            </div>

            {editable && !rejecting && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                <button
                  type="button" onClick={processRefund} disabled={busy || !refund.canProcess || !!live.error}
                  style={{ ...s.primaryBtn, opacity: busy || !refund.canProcess || live.error ? 0.6 : 1 }}
                  title={refund.canProcess ? undefined : 'Mark the booking cancelled first'}
                >
                  Process refund
                </button>
                <button type="button" onClick={() => setRejecting(true)} disabled={busy} style={s.dangerBtn}>Reject</button>
              </div>
            )}
            {rejecting && (
              <div style={s.field}>
                <span style={s.label}>Why is it rejected?</span>
                <textarea
                  value={rejectReason} maxLength={1000} rows={3} autoFocus
                  onChange={e => setRejectReason(e.target.value)}
                  style={{ ...s.input, height: 'auto', padding: 8 }}
                  placeholder="e.g. Non-refundable fare; the airline refunds nothing"
                />
                <span style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button type="button" onClick={rejectRefund} disabled={busy || !rejectReason.trim()} style={s.dangerBtn}>Reject refund</button>
                  <button type="button" onClick={() => setRejecting(false)} style={s.ghostBtn}>Keep it</button>
                </span>
                <span style={s.hint}>The traveller and the company see this reason on the booking.</span>
              </div>
            )}
            {refund.status === 'processed' && (
              <p style={s.hint}>Processed by {refund.processedBy ?? '—'} on {dateTime(refund.processedAt)}.</p>
            )}
          </section>
        </aside>
      </div>

      {refund.status === 'processed' && refund.creditNoteNo && (
        <>
          <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
            <button type="button" onClick={() => window.print()} style={s.primaryBtn}>Print credit note</button>
          </div>
          <CreditNote
            creditNoteNo={refund.creditNoteNo} refundDate={refund.refundDate} mode={refund.mode} remark={refund.remark}
            processedBy={refund.processedBy} parties={data.parties} ticket={ticket} computation={c}
          />
        </>
      )}
    </div>
  )
}

function Back() {
  return <Link href="/tmc/configurations/cancellation-queues" className="no-print" style={{ ...s.linkBtn, display: 'inline-block' }}>← Cancellation queues</Link>
}

const p: Record<string, React.CSSProperties> = {
  card: { background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, padding: '16px 18px', marginBottom: 16 },
  h2: { fontSize: 13, fontWeight: 700, color: 'var(--color-ink)', margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.04em' },
  facts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px 18px', margin: 0 },
  fact: { minWidth: 0 },
  factRow: { display: 'flex', justifyContent: 'space-between', gap: 12 },
  factK: { fontSize: 11, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  factV: { margin: '2px 0 0', fontSize: 13, color: 'var(--color-ink)', overflowWrap: 'anywhere' },
  columns: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' },
  left: { flex: '2 1 520px', minWidth: 0 },
  right: { flex: '1 1 300px', minWidth: 0 },
  stmt: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  k: { padding: '7px 0', borderBottom: '1px solid #F3F4F6', color: 'var(--color-body)' },
  v: { padding: '7px 0', borderBottom: '1px solid #F3F4F6', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  sub: { padding: '2px 0 7px 12px', fontSize: 11.5, color: 'var(--color-secondary)' },
  subInline: { display: 'block', fontSize: 11.5, color: 'var(--color-secondary)', marginTop: 2 },
  totalK: { padding: '10px 0 2px', fontWeight: 700, color: 'var(--color-ink)' },
  totalV: { padding: '10px 0 2px', fontWeight: 700, color: 'var(--color-ink)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  tag: { marginLeft: 8, fontSize: 10, fontWeight: 600, color: 'var(--color-secondary)', background: '#F3F4F6', borderRadius: 4, padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.04em' },
  tagEdited: { color: '#92400E', background: '#FEF3C7' },
  bigLabel: { fontSize: 11, color: 'var(--color-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 },
  big: { fontSize: 28, fontWeight: 700, color: 'var(--color-ink)', margin: '2px 0 0', fontVariantNumeric: 'tabular-nums' },
}
