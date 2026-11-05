'use client'

import { useState } from 'react'
import type { CancellationView, DeskCancellationView } from '@/app/lib/book/cancellation'

// ── Cancelling a booking, on its own pages ───────────────────────────────────
// Two pieces, used by the confirm and ticket pages:
//
//   CancelBookingButton   "Cancel booking", then a confirmation with an
//                         optional reason, then POST /api/book/[id]/cancel
//   CancellationNotice    what happened: when, by whom, why, the charges,
//                         and (for the travel desk) the provider's figures
//
// The money shown is what the server sent for this person
// (app/lib/book/cancellation.ts): a traveller gets the charges and "refund
// being processed", never the airline's refund; `provider` reaches the desk
// only.
// ─────────────────────────────────────────────────────────────────────────────

export type CancellationInfo = CancellationView | DeskCancellationView

const amount = (n: number, currency: string) =>
  `${currency === 'INR' ? '₹' : `${currency} `}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export function CancellationNotice({
  cancellation, status, currency = 'INR',
}: { cancellation: CancellationInfo; status: string; currency?: string }) {
  const requested = status === 'cancel_requested'
  const provider = 'provider' in cancellation ? cancellation.provider : null
  return (
    <section style={s.notice} aria-label="Cancellation">
      <p style={s.noticeTitle}>{requested ? 'Cancellation requested' : 'This booking is cancelled'}</p>
      <p style={s.noticeLine}>
        {requested ? 'Requested' : 'Cancelled'} {when(cancellation.cancelledAt)}
        {cancellation.cancelledByName ? ` by ${cancellation.cancelledByName}` : ''}.
        {requested && ' The airline will confirm it shortly.'}
      </p>
      {cancellation.reason && <p style={s.noticeReason}>“{cancellation.reason}”</p>}
      <dl style={s.facts}>
        <div style={s.fact}>
          <dt style={s.factLabel}>Cancellation charges</dt>
          <dd style={s.factValue}>{cancellation.charges ? amount(cancellation.charges, currency) : 'None'}</dd>
        </div>
        <div style={s.fact}>
          <dt style={s.factLabel}>Refund</dt>
          <dd style={s.factValue}>
            {cancellation.refund === 'processing'
              ? 'Being processed by the airline'
              : 'None due: nothing was paid to the airline yet'}
          </dd>
        </div>
      </dl>
      {provider && (
        <div style={s.desk}>
          <p style={s.deskTitle}>Desk view: what the provider reported</p>
          <dl style={s.facts}>
            {([
              ['Airline refund', amount(provider.refundedAmount, currency)],
              ['Cancellation charge', amount(provider.cancellationCharge, currency)],
              ['Tax on the charge', amount(provider.serviceTaxOnRaf, currency)],
              ['Provider status', [provider.cancelStatus, provider.changeRequestStatus].filter(Boolean).join(' / ') || '—'],
              ['Change request', provider.changeRequestId || '—'],
              ['Transaction', provider.transactionId || '—'],
            ] as const).map(([label, value]) => (
              <div key={label} style={s.fact}>
                <dt style={s.factLabel}>{label}</dt>
                <dd style={s.factValue}>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  )
}

export function CancelBookingButton({
  bookingId, ticketed, onCancelled,
}: { bookingId: string; ticketed: boolean; onCancelled: (result: { status: string; warning?: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/book/${bookingId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error || 'Could not cancel this booking. Please try again.')
        return
      }
      setOpen(false)
      onCancelled({ status: data.status, warning: data.warning })
    } catch {
      setError('Could not reach the server. Your booking is unchanged; please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" style={s.openBtn} onClick={() => setOpen(true)}>
        Cancel booking
      </button>
    )
  }

  return (
    <section style={s.confirmCard} aria-label="Cancel this booking">
      <p style={s.confirmTitle}>Cancel this booking?</p>
      <p style={s.confirmText}>
        {ticketed
          ? 'The ticket will be cancelled with the airline. The airline may keep a cancellation charge; any refund is processed by the airline afterwards.'
          : 'The booking will be cancelled and the seat released. Nothing has been charged yet.'}
        {' '}This can’t be undone.
      </p>
      <label style={s.label} htmlFor={`cancel-reason-${bookingId}`}>Reason (optional)</label>
      <textarea
        id={`cancel-reason-${bookingId}`}
        style={s.textarea}
        maxLength={500}
        rows={2}
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="e.g. Meeting moved to next week"
      />
      {error && <p style={s.error} role="alert">{error}</p>}
      <div style={s.actions}>
        <button type="button" style={s.keepBtn} onClick={() => setOpen(false)} disabled={busy}>Keep booking</button>
        <button type="button" style={{ ...s.cancelBtn, opacity: busy ? 0.7 : 1 }} onClick={confirm} disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel booking'}
        </button>
      </div>
    </section>
  )
}

const s: Record<string, React.CSSProperties> = {
  notice: { background: 'var(--color-surface)', border: '1px solid var(--color-line)', borderRadius: '14px', padding: '16px', marginBottom: '16px' },
  noticeTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--color-ink)', margin: '0 0 4px' },
  noticeLine: { fontSize: '12.5px', color: 'var(--color-muted)', margin: '0 0 6px', lineHeight: 1.5 },
  noticeReason: { fontSize: '12.5px', color: 'var(--color-body)', margin: '0 0 8px', fontStyle: 'italic' },
  facts: { margin: '8px 0 0', display: 'grid', gap: '4px' },
  fact: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12.5px' },
  factLabel: { color: 'var(--color-muted)' },
  factValue: { margin: 0, color: 'var(--color-ink)', fontWeight: 600, textAlign: 'right' },
  desk: { marginTop: '12px', paddingTop: '10px', borderTop: '1px dashed var(--color-line-strong)' },
  deskTitle: { fontSize: '11px', fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--color-info-fg)', margin: 0 },

  openBtn: {
    height: '44px', width: '100%', background: 'transparent', color: 'var(--color-danger-fg)', fontSize: '13px',
    fontWeight: 600, border: '1px solid var(--color-danger-line)', borderRadius: '10px', cursor: 'pointer', marginTop: '12px',
  },
  confirmCard: { background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-line)', borderRadius: '14px', padding: '16px', marginTop: '12px' },
  confirmTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--color-danger-fg)', margin: '0 0 6px' },
  confirmText: { fontSize: '12.5px', color: 'var(--color-body)', margin: '0 0 10px', lineHeight: 1.5 },
  label: { display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--color-body)', marginBottom: '4px' },
  textarea: {
    width: '100%', boxSizing: 'border-box', fontSize: '13px', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--color-line-strong)', background: 'var(--color-surface)', color: 'var(--color-ink)', resize: 'vertical',
  },
  error: { fontSize: '12.5px', color: 'var(--color-danger-fg)', margin: '8px 0 0' },
  actions: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' },
  keepBtn: {
    flex: '1 1 140px', height: '40px', background: 'var(--color-surface)', color: 'var(--color-ink)', fontSize: '13px',
    fontWeight: 600, border: '1px solid var(--color-line-strong)', borderRadius: '10px', cursor: 'pointer',
  },
  cancelBtn: {
    flex: '1 1 140px', height: '40px', background: 'var(--color-danger-fg)', color: '#fff', fontSize: '13px',
    fontWeight: 700, border: 'none', borderRadius: '10px', cursor: 'pointer',
  },
}
