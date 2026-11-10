import type React from 'react'
import type { RefundComputation } from '@/app/lib/refunds/compute'
import { money, dateOnly, MODE_LABELS } from '../ui'

// ── The credit note, as printed ──────────────────────────────────────────────
// Rendered on a processed refund. `ticket-sheet` is the class the print rules
// in globals.css keep on paper (everything else on the page is hidden), the
// same mechanism the e-ticket uses, so "Print credit note" needs no library
// and "Save as PDF" in the print dialog gives the PDF.
// ─────────────────────────────────────────────────────────────────────────────

export interface Parties {
  issuer: { name: string; branch: string | null; gstin: string | null; gst_name: string | null; city: string | null; state: string | null; zip: string | null }
  recipient: { name: string; gstin: string | null; gst_holder: string | null; address: string | null; city: string | null; state: string | null; zip: string | null }
}

interface Props {
  creditNoteNo: string
  refundDate: string | null
  mode: string | null
  remark: string | null
  processedBy: string | null
  parties: Parties | null
  ticket: { passenger: string | null; pnr: string | null; airlinePnr: string | null; ticketNumber: string | null; sector: string | null; departure: string | null; reference: string | null }
  computation: RefundComputation
}

export default function CreditNote({ creditNoteNo, refundDate, mode, remark, processedBy, parties, ticket, computation: c }: Props) {
  const place = (p: { city: string | null; state: string | null; zip: string | null }) => [p.city, p.state, p.zip].filter(Boolean).join(', ')
  const deductions = c.deductions.filter(d => d.amount)
  return (
    <section className="ticket-sheet" style={s.sheet} aria-label="Credit note">
      <header style={s.head}>
        <div>
          <p style={s.kicker}>Credit note</p>
          <p style={s.number}>{creditNoteNo}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={s.small}>Date</p>
          <p style={s.strong}>{dateOnly(refundDate)}</p>
        </div>
      </header>

      <div style={s.parties}>
        <div>
          <p style={s.small}>From</p>
          <p style={s.strong}>{parties?.issuer.gst_name || parties?.issuer.name || '—'}</p>
          {parties?.issuer.branch && <p style={s.line}>{parties.issuer.branch}</p>}
          {parties && <p style={s.line}>{place(parties.issuer)}</p>}
          <p style={s.line}>GSTIN {parties?.issuer.gstin || 'not recorded'}</p>
        </div>
        <div>
          <p style={s.small}>To</p>
          <p style={s.strong}>{parties?.recipient.gst_holder || parties?.recipient.name || '—'}</p>
          {parties?.recipient.address && <p style={s.line}>{parties.recipient.address}</p>}
          {parties && <p style={s.line}>{place(parties.recipient)}</p>}
          <p style={s.line}>GSTIN {parties?.recipient.gstin || 'not recorded'}</p>
        </div>
      </div>

      <table style={s.meta}>
        <tbody>
          <tr><td style={s.metaK}>Passenger</td><td style={s.metaV}>{ticket.passenger ?? '—'}</td><td style={s.metaK}>Ticket</td><td style={s.metaV}>{ticket.ticketNumber ?? '—'}</td></tr>
          <tr><td style={s.metaK}>Sector</td><td style={s.metaV}>{ticket.sector ?? '—'} · {dateOnly(ticket.departure)}</td><td style={s.metaK}>PNR</td><td style={s.metaV}>{ticket.pnr ?? '—'}{ticket.airlinePnr && ticket.airlinePnr !== ticket.pnr ? ` / ${ticket.airlinePnr}` : ''}</td></tr>
          <tr><td style={s.metaK}>Booking reference</td><td style={s.metaV}>{ticket.reference ?? '—'}</td><td style={s.metaK}>Original invoice</td><td style={s.metaV}>Not issued</td></tr>
        </tbody>
      </table>

      <table style={s.lines}>
        <tbody>
          <tr><td style={s.lineK}>Amount paid for this ticket</td><td style={s.lineV}>{money(c.charged.totalPaid)}</td></tr>
          {deductions.map(d => (
            <tr key={d.key}><td style={s.lineK}>Less: {d.label}</td><td style={s.lineV}>− {money(d.amount)}</td></tr>
          ))}
          {c.gst.onTmcFee.igst > 0 && <tr><td style={s.lineSub}>of which IGST {c.gst.rate}%</td><td style={s.lineSubV}>{money(c.gst.onTmcFee.igst)}</td></tr>}
          {c.gst.onTmcFee.cgst > 0 && <tr><td style={s.lineSub}>of which CGST {c.gst.rate / 2}% + SGST {c.gst.rate / 2}%</td><td style={s.lineSubV}>{money(c.gst.onTmcFee.cgst)} + {money(c.gst.onTmcFee.sgst)}</td></tr>}
          {c.result.roundOff !== 0 && <tr><td style={s.lineK}>Round off</td><td style={s.lineV}>{money(c.result.roundOff)}</td></tr>}
          <tr><td style={s.totalK}>Amount credited</td><td style={s.totalV}>{money(c.result.refundAmount)}</td></tr>
        </tbody>
      </table>

      <p style={s.line}>Refund by: {mode ? MODE_LABELS[mode] ?? mode : '—'}</p>
      {remark && <p style={s.line}>Remark: {remark}</p>}
      <footer style={s.foot}>
        <span>Processed by {processedBy ?? '—'}</span>
        <span>Computer-generated; no signature required.</span>
      </footer>
    </section>
  )
}

const s: Record<string, React.CSSProperties> = {
  sheet: { background: '#fff', border: '1px solid var(--color-line)', borderRadius: 10, padding: '22px 24px', marginTop: 16 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #111827', paddingBottom: 12, marginBottom: 14 },
  kicker: { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#374151', margin: 0 },
  number: { fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: '#111827', margin: '4px 0 0' },
  small: { fontSize: 10.5, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 },
  strong: { fontSize: 13.5, fontWeight: 600, color: '#111827', margin: '3px 0 2px' },
  line: { fontSize: 12, color: '#374151', margin: '2px 0' },
  parties: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18, marginBottom: 14 },
  meta: { width: '100%', borderCollapse: 'collapse', margin: '6px 0 14px', fontSize: 12 },
  metaK: { color: '#6B7280', padding: '4px 8px 4px 0', whiteSpace: 'nowrap' },
  metaV: { color: '#111827', padding: '4px 16px 4px 0' },
  lines: { width: '100%', borderCollapse: 'collapse', margin: '0 0 12px', fontSize: 13 },
  lineK: { padding: '6px 0', borderBottom: '1px solid #F3F4F6', color: '#374151' },
  lineV: { padding: '6px 0', borderBottom: '1px solid #F3F4F6', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  lineSub: { padding: '2px 0 6px 14px', fontSize: 11.5, color: '#6B7280' },
  lineSubV: { padding: '2px 0 6px', fontSize: 11.5, color: '#6B7280', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  totalK: { padding: '10px 0 4px', fontWeight: 700, color: '#111827', borderTop: '2px solid #111827' },
  totalV: { padding: '10px 0 4px', fontWeight: 700, color: '#111827', borderTop: '2px solid #111827', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  foot: { display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 16, paddingTop: 10, borderTop: '1px solid var(--color-line)', fontSize: 11, color: '#6B7280' },
}
