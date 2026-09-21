import { describe, it, expect } from 'vitest'
import { baggageLabel } from './types'

// ── baggageLabel ─────────────────────────────────────────────────────────────
// The industry files checked baggage under two different concepts, and a fare
// uses one or the other:
//
//   WEIGHT  India's domestic market  -> CheckIn = "15"
//   PIECES  most international long-haul -> CheckIn = "0", CheckInPiece = "2"
//
// Only the weight field was ever read, and the unit was hardcoded at three
// separate render sites. A DEL->FCO ticket with a 2-piece allowance therefore
// printed "Baggage 0 kg" -- a confident claim that the traveller gets no
// checked bag, on the one document they pack against.
//
// "0" is a non-empty string and so passed every truthiness check that was
// guarding these renders. That is the specific trap these tests pin down.
// ─────────────────────────────────────────────────────────────────────────────

describe('baggageLabel', () => {
  it('formats a weight allowance', () => {
    expect(baggageLabel('15', undefined)).toBe('15 kg')
    expect(baggageLabel('25', null)).toBe('25 kg')
  })

  it('formats a piece allowance', () => {
    expect(baggageLabel('0', '2')).toBe('2 pieces')
  })

  it('says "piece" singular for exactly one', () => {
    expect(baggageLabel(null, '1')).toBe('1 piece')
  })

  it('treats "0" as NOT an allowance, in either field', () => {
    // The whole bug: "0" is truthy as a string, so it rendered as "0 kg".
    expect(baggageLabel('0', undefined)).toBeNull()
    expect(baggageLabel(undefined, '0')).toBeNull()
    expect(baggageLabel('0', '0')).toBeNull()
  })

  it('returns null when the fare filed neither', () => {
    // Null rather than "0" or a dash: the decision to SAY NOTHING lives with
    // the data, not with each page.
    expect(baggageLabel(null, null)).toBeNull()
    expect(baggageLabel(undefined, undefined)).toBeNull()
    expect(baggageLabel('', '')).toBeNull()
  })

  it('prefers weight when a fare somehow files both', () => {
    // Weight is the stricter of the two to pack to.
    expect(baggageLabel('15', '2')).toBe('15 kg')
  })

  it('ignores values that are not numbers', () => {
    expect(baggageLabel('unknown', null)).toBeNull()
    expect(baggageLabel(null, 'two')).toBeNull()
  })
})
