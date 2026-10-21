import { describe, it, expect } from 'vitest'
import { evaluateBooking } from '@/app/lib/rule-engine/evaluateBooking'
import { buildPolicyInputsFromFlight } from '@/app/lib/rule-engine/buildPolicyInputs'
import type { ResolvedPolicy } from '@/app/lib/rule-engine/resolveEffectivePolicy'
import { fareTypeOf } from '@/app/lib/policy/fareTypes'
import { filterResults, refusalFor, NO_LISTS, type PolicyLists } from '@/app/lib/policy/searchFilter'
import { breachLine } from '@/app/lib/policy/breachText'
import type { FareOption, FlatFlightResult, Journey } from '@/app/lib/book/types'

// ── The policy checks added on 2026-10-19 ────────────────────────────────────
// Carrier tier, refundable fare, advance booking, max stops and max journey
// time (part of the verdict), and the airline / fare-type lists (not a verdict:
// those fares are not shown). Each check has a case that breaches and one that
// does not, so removing the check fails a test.
// ─────────────────────────────────────────────────────────────────────────────

// 01:30 on 20 October in India, still the 19th in UTC: "today" is the 20th.
const NOW = new Date('2026-10-19T20:00:00Z')

function journey(no: number, from: string, to: string, dep: string, stops = 0, duration = '02:00', airline = 'AI'): Journey {
  const legs = Array.from({ length: stops + 1 }, () => ({ airlineCode: airline }))
  return {
    journeyNo: no, stops: [], stopCount: stops, legs, totalDuration: duration,
    origin: { code: from, name: from, city: from, dateTime: dep },
    destination: { code: to, name: to, city: to, dateTime: dep },
    airline: { code: airline, name: airline },
  }
}

function fare(extra: Partial<FareOption> = {}): FareOption {
  return { pricingKey: 'PK', totalFare: 5000, baseFare: 4000, changePenalties: [], cancelPenalties: [], fareType: 'NRM', ...extra }
}

function flight(extra: Partial<FlatFlightResult> = {}, journeys = [journey(1, 'DEL', 'BOM', '2026-11-20T08:00:00')]): FlatFlightResult {
  return {
    flightKey: 'k', provider: 'test', isLcc: false, itemNo: '1', cabin: 'Economy',
    journeys, legs: journeys.flatMap(j => j.legs), airline: journeys[0].airline,
    origin: journeys[0].origin, destination: journeys[0].destination,
    stopCount: journeys[0].stopCount, stops: [], fareOptions: [fare()],
    ...extra,
  }
}

function policy(limits: Record<string, number | boolean>): ResolvedPolicy {
  return { ok: true, policyGroupId: 'g', policyGroupName: 'G', bandCode: 'L1', bandRank: 1, version: 1, limits, lists: {} }
}

function judge(limits: Record<string, number | boolean>, f: FlatFlightResult, isRefundable = true) {
  const inputs = buildPolicyInputsFromFlight({ flight: f, totalFare: 5000, isRefundable, now: NOW })
  return evaluateBooking(policy(limits), inputs)
}

const keys = (r: ReturnType<typeof judge>) => r.breaches.map(b => `${b.limit_key}:${b.severity}`)

describe('verdict checks', () => {
  it('carrier tier: a full-service carrier on a budget-only policy is out of policy', () => {
    expect(keys(judge({ carrier_tier: 0 }, flight({ isLcc: false })))).toEqual(['carrier_tier:red'])
    expect(keys(judge({ carrier_tier: 0 }, flight({ isLcc: true })))).toEqual([])
    expect(keys(judge({ carrier_tier: 1 }, flight({ isLcc: false })))).toEqual([])
  })

  it('refundable fare required: a non-refundable fare is red; a refundable one, or no requirement, is fine', () => {
    expect(keys(judge({ refundable_fare_required: true }, flight(), false))).toEqual(['refundable_fare_required:red'])
    expect(keys(judge({ refundable_fare_required: true }, flight(), true))).toEqual([])
    expect(keys(judge({ refundable_fare_required: false }, flight(), false))).toEqual([])
  })

  it('advance booking: counted in days from today in India to the departure date', () => {
    const on = (date: string) => flight({}, [journey(1, 'DEL', 'BOM', date)])
    // 20 Oct (today in India) -> 0 days; 25 Oct -> 5; 30 Oct -> 10. Any day
    // short is out of policy: only fare caps have grace.
    expect(judge({ advance_booking_days: 7 }, on('2026-10-20T23:00:00')).breaches[0])
      .toMatchObject({ limit_key: 'advance_booking_days', actualValue: 0, policyValue: 7, severity: 'red' })
    expect(keys(judge({ advance_booking_days: 7 }, on('2026-10-25T08:00:00')))).toEqual(['advance_booking_days:red'])
    expect(keys(judge({ advance_booking_days: 7 }, on('2026-10-30T08:00:00')))).toEqual([])
    // No usable departure: not judged, rather than guessed.
    expect(keys(judge({ advance_booking_days: 7 }, on('soon')))).toEqual([])
  })

  it('max stops: per direction, the worst one; 0 is non-stop only, 3 is any', () => {
    const oneStop = flight({}, [journey(1, 'DEL', 'BOM', '2026-11-20T08:00:00', 1)])
    expect(keys(judge({ max_stops: 0 }, oneStop))).toEqual(['max_stops:red'])
    expect(keys(judge({ max_stops: 1 }, oneStop))).toEqual([])
    // "Any" is stored as 3 and never fires, even for more stops than that.
    const fourStops = flight({}, [journey(1, 'DEL', 'BOM', '2026-11-20T08:00:00', 4)])
    expect(keys(judge({ max_stops: 3 }, fourStops))).toEqual([])
    expect(keys(judge({ max_stops: 2 }, fourStops))).toEqual(['max_stops:red'])
    // A non-stop round trip: the turnaround is not a stop.
    const nonStopReturn = flight({}, [
      journey(1, 'DEL', 'BOM', '2026-11-20T08:00:00'), journey(2, 'BOM', 'DEL', '2026-11-22T08:00:00'),
    ])
    expect(keys(judge({ max_stops: 0 }, nonStopReturn))).toEqual([])
  })

  it('max journey time: the longest direction, layovers included', () => {
    const long = flight({}, [
      journey(1, 'DEL', 'LHR', '2026-11-20T08:00:00', 1, '13:30'), journey(2, 'LHR', 'DEL', '2026-11-28T08:00:00', 0, '09:00'),
    ])
    expect(judge({ max_journey_hours: 12 }, long).breaches[0]).toMatchObject({ limit_key: 'max_journey_hours', actualValue: 13.5 })
    expect(keys(judge({ max_journey_hours: 14 }, long))).toEqual([])
  })

  it('max layover: the longest wait at any stop, in any direction', () => {
    const via = (arrive: string, leave: string) => {
      const j = journey(1, 'DEL', 'LHR', '2026-11-20T08:00:00', 1)
      return flight({}, [{ ...j, stops: [{ code: 'DXB', city: 'Dubai', arrivalDateTime: arrive, departureDateTime: leave }] }])
    }
    expect(judge({ max_layover_hours: 4 }, via('2026-11-20T11:00:00', '2026-11-20T16:30:00')).breaches[0])
      .toMatchObject({ limit_key: 'max_layover_hours', actualValue: 5.5, severity: 'red' })
    expect(keys(judge({ max_layover_hours: 6 }, via('2026-11-20T11:00:00', '2026-11-20T16:30:00')))).toEqual([])
    // Overnight, across the date.
    expect(judge({ max_layover_hours: 4 }, via('2026-11-20T22:00:00', '2026-11-21T07:00:00')).breaches[0])
      .toMatchObject({ actualValue: 9 })
    // A non-stop flight has no layover to judge.
    expect(keys(judge({ max_layover_hours: 1 }, flight()))).toEqual([])
  })

  it('max cancellation fee: the adult fee as the airline writes it; non-refundable loses the whole fare', () => {
    const fee = (lines: { paxType: string; text: string }[] | undefined, isRefundable = true) =>
      evaluateBooking(policy({ max_cancel_penalty: 3000 }),
        buildPolicyInputsFromFlight({ flight: flight(), totalFare: 5000, isRefundable, cancelPenalties: lines, now: NOW }))
    expect(fee([{ paxType: 'ADT', text: 'INR3500' }, { paxType: 'CHD', text: 'INR1000' }]).breaches[0])
      .toMatchObject({ limit_key: 'max_cancel_penalty', actualValue: 3500, severity: 'red' })
    expect(fee([{ paxType: 'ADT', text: 'INR 2500' }]).breaches).toEqual([])
    expect(fee([{ paxType: 'ADT', text: '0' }]).breaches).toEqual([])
    // Not read rather than guessed: another currency, words, nothing sent.
    expect(fee([{ paxType: 'ADT', text: 'USD80' }]).breaches).toEqual([])
    expect(fee([{ paxType: 'ADT', text: 'NON REFUNDABLE' }]).breaches).toEqual([])
    expect(fee(undefined).breaches).toEqual([])
    expect(fee(undefined, false).breaches[0]).toMatchObject({ actualValue: 5000 })
    expect(breachLine(fee([{ paxType: 'ADT', text: 'INR3500' }]).breaches[0]))
      .toBe('cancellation fee limit exceeded: ₹3,500 to cancel, the policy allows up to ₹3,000')
  })

  it('reads as one clause each, so several join into one reason', () => {
    const result = judge({ max_stops: 0, advance_booking_days: 7, refundable_fare_required: true, max_journey_hours: 1, carrier_tier: 0 },
      flight({}, [journey(1, 'DEL', 'BOM', '2026-10-21T08:00:00', 1, '05:00')]), false)
    expect(result.breaches).toHaveLength(5)
    for (const b of result.breaches) expect(breachLine(b)).not.toContain(';')
    expect(result.breaches.map(breachLine)).toEqual(expect.arrayContaining([
      'stop limit exceeded: 1 stop, the policy allows non-stop flights only',
      'minimum advance booking window not met: booked 1 day ahead, the policy asks for at least 7 days',
      'refundable fare requirement not met: this fare is non-refundable',
      'preferred carrier tier exceeded (policy: Budget only, actual: Full-service)',
    ]))
  })
})

describe('fare caps and grace', () => {
  const fareOf = (limits: Record<string, number | boolean>, amount: number, key = 'max_fare_domestic') =>
    evaluateBooking(policy(limits), { totalCost: amount, numericValues: { [key]: amount }, booleanValues: {} })

  it('no grace: any amount over the cap is out of policy', () => {
    expect(fareOf({ max_fare_domestic: 8000 }, 8000)).toMatchObject({ verdict: 'green', breaches: [] })
    expect(fareOf({ max_fare_domestic: 8000 }, 8001).verdict).toBe('red')
  })

  it('a percentage grace: within it needs approval, beyond it is out of policy', () => {
    const g = { max_fare_intl: 50000, fare_grace: 10, fare_grace_unit: 0 }
    expect(fareOf(g, 55000, 'max_fare_intl')).toMatchObject({ verdict: 'amber', breaches: [{ severity: 'amber', graceLimit: 55000 }] })
    expect(fareOf(g, 55001, 'max_fare_intl').verdict).toBe('red')
  })

  it('a fixed grace in rupees', () => {
    const g = { max_fare_domestic: 8000, fare_grace: 500, fare_grace_unit: 1 }
    expect(fareOf(g, 8500).verdict).toBe('amber')
    expect(fareOf(g, 8501).verdict).toBe('red')
  })

  it('grace never softens another rule, and the worst outcome wins', () => {
    const r = evaluateBooking(policy({ max_fare_domestic: 8000, fare_grace: 10, cabin_class_short_haul: 0 }), {
      totalCost: 8400, numericValues: { max_fare_domestic: 8400 }, booleanValues: {}, tierValues: { cabin_class_short_haul: 1 },
    })
    expect(keys(r)).toEqual(['max_fare_domestic:amber', 'cabin_class_short_haul:red'])
    expect(r.verdict).toBe('red')
  })

  it('the old approval amounts are not read', () => {
    expect(fareOf({ max_fare_domestic: 8000, auto_approve_under: 1000, finance_approval_over: 2000 }, 5000))
      .toEqual({ verdict: 'green', breaches: [] })
  })
})

describe('fare types', () => {
  it('brand first, then the supplier fare class, then NDC; unknown is retail', () => {
    expect(fareTypeOf({ fareType: 'NRM' })).toBe('RETAIL')
    expect(fareTypeOf({})).toBe('RETAIL')
    expect(fareTypeOf({ fareType: 'SOMETHING-NEW' })).toBe('RETAIL')
    expect(fareTypeOf({ fareType: 'CRP' })).toBe('CORPORATE')
    expect(fareTypeOf({ fareType: 'SME' })).toBe('SME')
    expect(fareTypeOf({ fareType: 'Tactical' })).toBe('TACTICAL')
    expect(fareTypeOf({ fareType: 'NRM', isNdc: true })).toBe('NDC')
    expect(fareTypeOf({ fareType: 'CRP', isNdc: true })).toBe('CORPORATE')
    expect(fareTypeOf({ fareType: 'NRM', brandedFareName: 'Stretch Plus' })).toBe('STRETCHPLUS')
    expect(fareTypeOf({ fareType: 'NRM', brandedFareName: 'STRETCH' })).toBe('STRETCH')
    expect(fareTypeOf({ fareType: 'NRM', brandedFareName: 'Super 6E' })).toBe('SUPER6E')
    expect(fareTypeOf({ fareType: 'CRP', brandedFareName: 'FLEXI PLUS' })).toBe('FLEXI')
  })
})

describe('what a traveller is shown', () => {
  const lists = (l: Partial<PolicyLists>): PolicyLists => ({ ...NO_LISTS, ...l })

  it('no lists: the results are untouched', () => {
    const results = [flight()]
    expect(filterResults(results, NO_LISTS)).toBe(results)
  })

  it('a blocked airline is removed, on any leg of any direction', () => {
    const viaBlocked = flight({}, [
      journey(1, 'DEL', 'BOM', '2026-11-20T08:00:00'), journey(2, 'BOM', 'DEL', '2026-11-22T08:00:00', 0, '02:00', 'SG'),
    ])
    const clean = flight({ flightKey: 'clean' })
    expect(filterResults([viaBlocked, clean], lists({ blockedAirlines: ['SG'] })).map(f => f.flightKey)).toEqual(['clean'])
  })

  it('fares of a type not allowed are removed, and the price shown follows the first fare left', () => {
    const f = flight({
      fareOptions: [fare({ pricingKey: 'retail', totalFare: 4000 }), fare({ pricingKey: 'corp', fareType: 'CRP', totalFare: 4500 })],
      pricingKey: 'retail', totalFare: 4000,
    })
    const [out] = filterResults([f], lists({ allowedFareTypes: ['CORPORATE'] }))
    expect(out.fareOptions.map(o => o.pricingKey)).toEqual(['corp'])
    expect(out).toMatchObject({ pricingKey: 'corp', totalFare: 4500 })
    // A flight with no allowed fare left is not shown at all.
    expect(filterResults([f], lists({ allowedFareTypes: ['SME'] }))).toEqual([])
  })

  it('a preferred airline is marked, not reordered', () => {
    const out = filterResults([flight({ flightKey: 'a' }), flight({ flightKey: 'b' }, [journey(1, 'DEL', 'BOM', '2026-11-20T08:00:00', 0, '02:00', '6E')])],
      lists({ preferredAirlines: ['6E'] }))
    expect(out.map(f => [f.flightKey, f.preferred ?? false])).toEqual([['a', false], ['b', true]])
  })

  it('price and add-passenger: the reason a fare is refused', () => {
    const f = flight()
    expect(refusalFor(f, fare(), lists({ blockedAirlines: ['AI'] }))).toBe("The traveller's travel policy does not allow AI flights.")
    expect(refusalFor(f, fare({ fareType: 'SME' }), lists({ allowedFareTypes: ['RETAIL'] }))).toBe("The traveller's travel policy does not allow SME fares.")
    expect(refusalFor(f, fare(), lists({ allowedFareTypes: ['RETAIL'] }))).toBeNull()
    expect(refusalFor(f, fare(), NO_LISTS)).toBeNull()
  })
})
