import { describe, it, expect } from 'vitest'
import {
  categoryForTravelType,
  isApprovalCategory,
  buildReason,
  APPROVAL_CATEGORIES,
  APPROVAL_CATEGORY_LABELS,
} from './resolveApprovalTier'
import type { VerdictBreach } from '../rule-engine/evaluateBooking'

// ── approval engine, pure parts ──────────────────────────────────────────────
// resolveChainForEmployee and raiseApprovals need a database client and are
// covered by route-level tests later. These are the pure functions: which
// approval bucket a booking routes to, and the sentence an approver reads when
// deciding.
//
// buildReason is not cosmetic. It is the only explanation a human sees before
// approving someone else's spend, so a breach that formats as a bare key --
// "max_fare_intl exceeded" -- is an approver guessing.
// ─────────────────────────────────────────────────────────────────────────────

function breach(overrides: Partial<VerdictBreach> = {}): VerdictBreach {
  return {
    limit_key: 'max_fare_domestic',
    kind: 'numeric',
    policyValue: 10000,
    actualValue: 15000,
    severity: 'amber',
    ...overrides,
  }
}

describe('categoryForTravelType', () => {
  it('routes any flight type to air', () => {
    expect(categoryForTravelType('flight')).toBe('air')
    expect(categoryForTravelType('flight_domestic')).toBe('air')
    expect(categoryForTravelType('flight_international')).toBe('air')
  })

  it('routes any hotel type to hotel', () => {
    expect(categoryForTravelType('hotel')).toBe('hotel')
    expect(categoryForTravelType('hotel_domestic')).toBe('hotel')
  })

  it('defaults an unclassified type to misc rather than to nothing', () => {
    // Matching no bucket would mean NO APPROVAL on a booking type nobody
    // remembered to classify -- the opposite of what an approval engine is for.
    expect(categoryForTravelType('car_rental')).toBe('misc')
    expect(categoryForTravelType('train')).toBe('misc')
    expect(categoryForTravelType('')).toBe('misc')
    expect(categoryForTravelType('something_invented_next_year')).toBe('misc')
  })
})

describe('isApprovalCategory', () => {
  it('accepts the three real categories', () => {
    expect(isApprovalCategory('air')).toBe(true)
    expect(isApprovalCategory('hotel')).toBe(true)
    expect(isApprovalCategory('misc')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isApprovalCategory('flight')).toBe(false)
    expect(isApprovalCategory('')).toBe(false)
  })

  it('has a label for every category', () => {
    // Guards the pairing: a fourth category added to one and not the other
    // would render as undefined on screen.
    for (const c of APPROVAL_CATEGORIES) {
      expect(APPROVAL_CATEGORY_LABELS[c]).toBeTruthy()
    }
  })
})

describe('buildReason', () => {
  it('says "Within policy" when nothing was breached', () => {
    expect(buildReason([])).toBe('Within policy')
  })

  it('names a numeric breach with both the policy and the actual value', () => {
    const reason = buildReason([breach()])

    expect(reason).toContain('domestic fare limit')
    expect(reason).toContain('10000')
    expect(reason).toContain('15000')
  })

  it('phrases a boolean breach as an entitlement, not a number', () => {
    // "red-eye flight restriction exceeded (policy: false, actual: true)" is
    // not a sentence. A boolean limit is permission, not a threshold.
    const reason = buildReason(
      [breach({ limit_key: 'red_eye_restricted', kind: 'boolean', policyValue: false, actualValue: true })],
    )

    expect(reason).toContain('red-eye flight restriction is not permitted for this employee')
    expect(reason).not.toContain('exceeded')
  })

  it('translates every known limit key to human words', () => {
    // A bare key leaves the approver guessing what they are approving.
    const reason = buildReason([breach({ limit_key: 'cabin_class_long_haul', kind: 'boolean' })])
    expect(reason).toContain('cabin class entitlement (long-haul)')
  })

  it('falls back to the raw key for a limit it does not know', () => {
    // Better than dropping the breach silently.
    const reason = buildReason([breach({ limit_key: 'some_future_limit' })])
    expect(reason).toContain('some_future_limit')
  })

  it('says which side of the grace a fare landed', () => {
    const within = buildReason([breach({ policyValue: 10000, actualValue: 10500, graceLimit: 11000 })])
    expect(within).toContain('within the ₹1,000 grace')
    const beyond = buildReason([breach({ policyValue: 10000, actualValue: 12000, graceLimit: 11000 })])
    expect(beyond).toContain('beyond the ₹1,000 grace')
  })

  it('joins several breaches into one readable sentence', () => {
    const reason = buildReason(
      [
        breach({ limit_key: 'max_fare_domestic' }),
        breach({ limit_key: 'advance_booking_days', policyValue: 14, actualValue: 2 }),
      ],
    )

    expect(reason).toContain('domestic fare limit')
    expect(reason).toContain('minimum advance booking window')
    expect(reason.split(';')).toHaveLength(2)
  })
})
