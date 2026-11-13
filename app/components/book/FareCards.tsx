'use client'

import type React from 'react'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import type { FareOption, FlatFlightResult, PenaltyLine } from '@/app/lib/book/types'

// ── FareCards ────────────────────────────────────────────────────────────────
// A flight's fare options side by side, each with what it includes: what the
// company pays, the policy verdict, refundability and the cancellation and
// change fees, baggage, meal, and the airline's own inclusions. One is chosen
// at a time. Used for a round trip's two flights, on the results (inside each
// column) and on the round trip's fare page.
// ─────────────────────────────────────────────────────────────────────────────

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const amountOf = (f: FareOption) => f.sellEstimate ?? f.totalFare

// The adult's fee as the airline sends it ("INR3000", "0"); null when it sent
// nothing useful ("Not Available" means the rules were not returned).
function fee(lines: PenaltyLine[] | undefined): string | null {
  const line = lines?.find(l => l.paxType === 'ADT') ?? lines?.[0]
  const text = line?.text?.trim()
  if (!text || text.toLowerCase() === 'not available') return null
  const n = /^(?:INR\s*)?(\d+(?:\.\d+)?)$/i.exec(text)
  if (n) return Number(n[1]) === 0 ? 'free' : inr(Number(n[1]))
  return text
}

// The airline shouts its inclusions ("FREE CHECKED BAGGAGE"); only the case changes.
const sentence = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()

export default function FareCards({ flight, selectedKey, onSelect, busy = false }: {
  flight: FlatFlightResult
  selectedKey: string | null
  onSelect: (fare: FareOption) => void
  busy?: boolean
}) {
  const bag = flight.checkInBaggageKg ? `${flight.checkInBaggageKg} kg check-in` : flight.checkInBaggagePieces ? `${flight.checkInBaggagePieces} check-in` : null
  const cabinBag = flight.cabinBaggageKg ? `${flight.cabinBaggageKg} kg cabin` : null
  return (
    <div style={grid} role="radiogroup" aria-label="Fares">
      {flight.fareOptions.map((fare, i) => {
        const chosen = fare.pricingKey === selectedKey
        const amount = amountOf(fare)
        const name = fare.brandedFareName || fare.fareType || `Fare ${i + 1}`
        const cancel = fee(fare.cancelPenalties)
        const change = fee(fare.changePenalties)
        const verdict = fare.policy ? VERDICT_META[fare.policy] : null
        return (
          <div key={fare.pricingKey || i} style={{ ...card, ...(chosen ? cardChosen : {}) }}>
            <div style={top}>
              <b style={title} title={name}>{name}</b>
              <span style={price}>{amount !== undefined ? inr(amount) : '—'}</span>
            </div>
            {verdict && (
              <span style={{ ...chip, color: verdict.color, background: verdict.bg, borderColor: verdict.border }}>{verdict.label}</span>
            )}
            <ul style={lines}>
              <li style={fare.refundable ? undefined : no}>
                {fare.refundable ? `Refundable${cancel ? `, cancellation ${cancel}` : ''}` : 'Non-refundable'}
              </li>
              {change && <li>Change {change}</li>}
              {(bag || cabinBag) && <li>{[bag, cabinBag].filter(Boolean).join(', ')}</li>}
              <li style={fare.mealIncluded ? undefined : no}>{fare.mealIncluded ? 'Meal included' : 'Meal not included'}</li>
              {(fare.brandedServices ?? []).slice(0, 4).map(sv => <li key={sv}>{sentence(sv)}</li>)}
            </ul>
            <button
              type="button" role="radio" aria-checked={chosen} disabled={busy}
              onClick={() => onSelect(fare)}
              style={{ ...btn, ...(chosen ? btnChosen : {}), opacity: busy ? 0.6 : 1 }}
            >
              {chosen ? 'Chosen' : 'Choose this fare'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }
const card: React.CSSProperties = { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }
const cardChosen: React.CSSProperties = { borderColor: '#000835', boxShadow: 'inset 0 0 0 1px #000835' }
const top: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }
const title: React.CSSProperties = { fontSize: 12, color: '#111827', textTransform: 'uppercase', letterSpacing: '0.3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const price: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: '#111827', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const chip: React.CSSProperties = { alignSelf: 'flex-start', fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 6, border: '1px solid' }
const lines: React.CSSProperties = { margin: 0, paddingLeft: 16, display: 'grid', gap: 3, fontSize: 12, color: '#374151' }
const no: React.CSSProperties = { color: '#9CA3AF' }
const btn: React.CSSProperties = { marginTop: 'auto', height: 32, borderRadius: 8, border: '1px solid #000835', background: '#fff', color: '#000835', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }
const btnChosen: React.CSSProperties = { background: '#000835', color: '#fff' }
