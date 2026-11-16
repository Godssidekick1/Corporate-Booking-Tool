import { describe, it, expect } from 'vitest'
import { parseFareRules, travellerFareRules, cleanRemark, hoursText } from './fareRules'
import { FARE_RULE_AI_ECOVALU, FARE_RULE_NO_FARE } from '@/tests/fixtures/amadeus/fareRule'

const NOW = new Date('2026-11-16T07:00:00Z')

describe('parseFareRules', () => {
  it('reads the Air India fare the test system returned', () => {
    const rules = parseFareRules(FARE_RULE_AI_ECOVALU, NOW)!
    expect(rules.unavailable).toEqual([])
    expect(rules.fetchedAt).toBe(NOW.toISOString())
    expect(rules.sectors).toHaveLength(1)
    const s = rules.sectors[0]
    expect(s).toMatchObject({ origin: 'DEL', destination: 'BOM', carrier: 'AI', travelDate: '2026-12-07 07:30', fareBasis: ['TU1YXSII'], dealCode: null })
    const adt = s.pax[0]
    expect(adt.paxType).toBe('ADT')

    // In the order time runs: free just after booking, then the fee, then no-show.
    expect(adt.cancel.map(w => [w.kind, w.label, w.amount, w.permitted])).toEqual([
      ['after_booking', 'Within 2 days of booking', 0, true],
      ['before_departure', 'More than 2 hours before departure', 5000, true],
      ['no_show', 'No-show, or less than 2 hours before departure', 0, false],
    ])
    expect(adt.change.find(w => w.kind === 'before_departure')).toMatchObject({ amount: 3500, currency: 'INR', fromHours: 2, toHours: 451 })
    expect(adt.cancel[1].note).toBe('Charge INR 5000 for cancel/refund. Note: till 2 hours charge INR 5000 per component for cancellation.')
  })

  it('reads the user’s sample shape: several windows, the furthest open-ended', () => {
    const remarks = JSON.stringify([{
      fareKey: 'X', validatingCarrier: '6e', fareBasis: 'R0IP', dealCode: 'CORP1', traveldate: '2026-12-01 10:00', origin: 'bom', destination: 'blr',
      policy: [{ paxType: 'adt', policies: [
        { policyType: 33, timeline: [{ condition: 1, charge: [
          { from: 2, to: 72, value: '4000', currency: 'inr', permitted: 'T' },
          { from: 72, to: 300, value: 2500, currency: 'INR', permitted: 'T' },
        ], Remark: 'CANCEL FEE APPLIES PER PAX' }] },
        { policyType: 99, timeline: [{ condition: 7, charge: [{ from: 0, to: 1, value: 0, currency: 'INR', permitted: 'T' }] }] },
      ] }],
    }])
    const s = parseFareRules({ Status: 'Success', Error: null, FareRulesFlight: [{ Remarks: remarks }] }, NOW)!.sectors[0]
    expect(s.carrier).toBe('6E')
    expect(s.dealCode).toBe('CORP1')
    expect(s.fareBasis).toEqual(['R0IP'])
    expect(s.pax[0].cancel.map(w => [w.label, w.amount])).toEqual([
      ['More than 3 days before departure', 2500],
      ['2 hours to 3 days before departure', 4000],
    ])
    expect(s.pax[0].cancel[0].note).toBe('Cancel fee applies per passenger.')
    // Unknown types are kept, labelled by their code.
    expect(s.pax[0].other).toEqual([{ policyType: 99, windows: [expect.objectContaining({ kind: 'other', label: 'Rule 7' })] }])
  })

  it('the GDS’s “no fare” answer is a note, not a crash', () => {
    const rules = parseFareRules(FARE_RULE_NO_FARE, NOW)!
    expect(rules.sectors).toEqual([])
    expect(rules.unavailable).toEqual(['No fare for booking code-try other pricing options.'])
  })

  it('remarks that are not JSON, or nothing at all', () => {
    expect(parseFareRules({ Status: 'Success', Error: null, FareRulesFlight: [{ Remarks: '{oops' }] }, NOW)!.unavailable)
      .toEqual(['The airline’s rules could not be read.'])
    expect(parseFareRules({ Status: 'Success', Error: null, FareRulesFlight: [] }, NOW)).toBeNull()
    expect(parseFareRules({ Status: 'Success', Error: null, FareRulesFlight: null }, NOW)).toBeNull()
    expect(parseFareRules(null, NOW)).toBeNull()
    // Rubbish inside a valid array is skipped.
    const junk = JSON.stringify([null, 4, { policy: [{ policies: [{ policyType: 33, timeline: [{ charge: [{ from: 'x' }] }] }] }] }])
    const r = parseFareRules({ Status: 'Success', Error: null, FareRulesFlight: [{ Remarks: junk }] }, NOW)!
    expect(r.sectors[0].pax[0].cancel).toEqual([])
  })

  it('the traveller’s copy has no deal code', () => {
    const remarks = JSON.stringify([{ dealCode: 'SECRET', origin: 'DEL', destination: 'BOM', policy: [{ paxType: 'ADT', policies: [] }] }])
    const rules = parseFareRules({ Status: 'Success', Error: null, FareRulesFlight: [{ Remarks: remarks }] }, NOW)!
    expect(rules.sectors[0].dealCode).toBe('SECRET')
    expect(JSON.stringify(travellerFareRules(rules))).not.toContain('SECRET')
  })
})

describe('cleanRemark and hoursText', () => {
  it('tidies GDS shorthand without rewriting it', () => {
    expect(cleanRemark('  NO SHOW IS WHEN A PAX FAILS TO CHANGE ATLEAST 02 HRS BEFORE DEPARTURE ')).toBe(
      'No show is when a passenger fails to change at least 2 hours before departure.')
    expect(cleanRemark('100 percent of basic fare plus yq will be forfeited. only tax refundable')).toBe(
      '100 percent of basic fare plus YQ will be forfeited. Only tax refundable.')
    expect(cleanRemark('')).toBeNull()
    expect(cleanRemark(42)).toBeNull()
    expect(cleanRemark('x'.repeat(900))!.length).toBe(600)
  })

  it('hours read as days when whole', () => {
    expect(hoursText(1)).toBe('1 hour')
    expect(hoursText(2)).toBe('2 hours')
    expect(hoursText(24)).toBe('24 hours')
    expect(hoursText(72)).toBe('3 days')
    expect(hoursText(160)).toBe('160 hours')
  })
})
