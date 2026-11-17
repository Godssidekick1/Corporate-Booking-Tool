'use client'

import { useState } from 'react'
import Link from 'next/link'
import { POLICY_REASONS } from '@/app/lib/book/policyReasons'
import { ButtonBusy } from '@/app/components/FlowLoader'

// ── A booking sent back: the fare rose out of policy while it waited ─────────
// An approver's "Refresh fare" found the fare higher and now outside the
// traveller's policy beyond its grace (status reapproval_needed). The approver
// does not decide on a price the traveller never asked for, so the traveller
// chooses: ask for approval again at the new price, with a reason
// (POST /api/book/[bookingId]/reapproval), or choose another flight.
// ─────────────────────────────────────────────────────────────────────────────

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

export default function AskAgainCard({ bookingId, newTotal, note, onAsked, cancel }: {
  bookingId: string
  newTotal: number
  // The closed step's note, written by the refresh: "The fare rose from ₹X to ₹Y …"
  note: string | null
  onAsked: () => void
  cancel?: React.ReactNode
}) {
  const [reasonCode, setReasonCode] = useState('')
  const [reasonNote, setReasonNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const rose = note?.match(/from (₹[\d,]+) to (₹[\d,]+)/)
  const headline = rose
    ? `The fare rose from ${rose[1]} to ${rose[2]} while this booking waited, and is now outside your travel policy.`
    : `The fare has risen to ${inr(newTotal)} while this booking waited, and is now outside your travel policy.`

  async function ask() {
    setError('')
    if (!reasonCode) { setError('Choose why this booking should go ahead at the new price.'); return }
    if (reasonCode === 'other' && !reasonNote.trim()) { setError('Explain the reason for "Other".'); return }
    setSending(true)
    try {
      const res = await fetch(`/api/book/${bookingId}/reapproval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasonCode, note: reasonNote.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'Could not send it for approval. Please try again.'); return }
      onAsked()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={s.card}>
      <p style={s.title}>This booking needs your decision</p>
      <p style={s.text}>{headline}</p>
      <p style={s.text}>
        Ask for approval again at {inr(newTotal)} with a reason, or choose another flight. Nothing is booked until it is approved.
      </p>

      <div style={s.form}>
        <label style={s.label} htmlFor="ask-again-reason">Why should it go ahead at the new price?</label>
        <select id="ask-again-reason" value={reasonCode} onChange={e => setReasonCode(e.target.value)} style={s.input}>
          <option value="">Choose a reason</option>
          {POLICY_REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
        <textarea
          value={reasonNote}
          onChange={e => setReasonNote(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder={reasonCode === 'other' ? 'Explain the reason (required)' : 'Add a note for the approver (optional)'}
          style={{ ...s.input, height: 'auto', padding: '8px 10px', resize: 'vertical' }}
          aria-label="Note for the approver"
        />
        {error && <p style={s.error} role="alert">{error}</p>}
      </div>

      <div style={s.actions}>
        <button type="button" onClick={ask} disabled={sending} style={s.primary}>
          {sending ? <ButtonBusy label="Sending for approval" /> : 'Ask for approval again'}
        </button>
        <Link href="/book/flights" style={s.secondary}>Choose another flight</Link>
      </div>
      {cancel}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--color-warn-bg)', border: '1px solid var(--color-warn-line)', borderRadius: 14,
    padding: '18px 18px 16px', marginBottom: 16,
  },
  title: { fontSize: 15, fontWeight: 700, color: 'var(--color-warn-fg)', margin: '0 0 6px' },
  text: { fontSize: 13, color: 'var(--color-body)', margin: '0 0 6px', lineHeight: 1.55 },
  form: { display: 'grid', gap: 8, margin: '12px 0 14px' },
  label: { fontSize: 12, fontWeight: 600, color: 'var(--color-ink)' },
  input: {
    height: 38, borderRadius: 8, border: '1px solid var(--color-line-strong)', background: 'var(--color-surface)',
    padding: '0 10px', fontSize: 13, color: 'var(--color-ink)', fontFamily: 'inherit',
  },
  error: { fontSize: 12, color: 'var(--color-danger-fg)', margin: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  primary: {
    height: 42, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13.5, fontWeight: 700,
    border: 'none', borderRadius: 10, cursor: 'pointer',
  },
  secondary: {
    height: 42, padding: '0 18px', display: 'inline-flex', alignItems: 'center', background: 'var(--color-surface)',
    color: '#000835', fontSize: 13.5, fontWeight: 700, border: '1.5px solid #000835', borderRadius: 10, textDecoration: 'none',
  },
}
