import { describe, it, expect } from 'vitest'
import { penaltyFromRules, departureOf, rulePaxType, windowAt } from './penaltyFromRules'
import { parseFareRules, type FareRules } from '@/app/lib/book/fareRules'
import { FARE_RULE_AI_ECOVALU } from '@/tests/fixtures/amadeus/fareRule'

// The probe's Air India fare: departs 2026-12-07 07:30 India time (02:00 UTC).
// Free within 48 hours of booking (451–499 hours before departure), INR 5,000
// from 2 hours before departure, no-show non-refundable.
const RULES = parseFareRules(FARE_RULE_AI_ECOVALU, new Date('2026-11-16T07:00:00Z'))!

function withSectors(edit: (raw: unknown[]) => unknown[]): FareRules {
  const raw = JSON.parse(FARE_RULE_AI_ECOVALU.FareRulesFlight[0].Remarks) as unknown[]
  return parseFareRules({ Status: 'Success', Error: null, FareRulesFlight: [{ Remarks: JSON.stringify(edit(raw)) }] })!
}

const at = (iso: string, extra: Partial<Parameters<typeof penaltyFromRules>[1]> = {}) =>
  penaltyFromRules(RULES, { paxType: 'ADT', cancelledAt: iso, providerCharge: 0, ...extra })

describe('penaltyFromRules', () => {
  it('inside the fee window: the fee, with how it was reached', () => {
    const r = at('2026-11-25T00:00:00Z')!
    expect(r.amount).toBe(5000)
    expect(r.rulesAmount).toBe(5000)
    expect(r.basis).toEqual(['DEL → BOM: ₹5,000 (more than 2 hours before departure; cancelled 290 hours before departure)'])
    expect(r.warnings).toEqual([])
  })

  it('within 48 hours of booking: free', () => {
    const r = at('2026-11-16T08:00:00Z')!
    expect(r.amount).toBe(0)
    expect(r.basis[0]).toMatch(/free \(within 2 days of booking/)
  })

  it('in the last two hours, or after departure: no-show, non-refundable, nothing prefilled', () => {
    for (const when of ['2026-12-07T01:00:00Z', '2026-12-07T05:00:00Z']) {
      const r = at(when)!
      expect(r.amount).toBeNull()
      expect(r.rulesAmount).toBeNull()
      expect(r.warnings[0]).toMatch(/non-refundable as a no-show/)
    }
  })

  it('the provider already charged: not added again, the rules shown as a check', () => {
    const same = at('2026-11-25T00:00:00Z', { providerCharge: 5000 })!
    expect(same.amount).toBeNull()
    expect(same.rulesAmount).toBe(5000)
    expect(same.warnings).toEqual(['The airline already charged ₹5,000 on cancelling, the same as the fare rules. Not added again.'])
    const differs = at('2026-11-25T00:00:00Z', { providerCharge: 3000 })!
    expect(differs.warnings[0]).toMatch(/charged ₹3,000 on cancelling; the fare rules say ₹5,000/)
  })

  it('two sectors add up', () => {
    const rules = withSectors(raw => [raw[0], { ...(raw[0] as object), origin: 'BOM', destination: 'DEL', traveldate: '2026-12-10 18:00' }])
    const r = penaltyFromRules(rules, { paxType: 'ADT', cancelledAt: '2026-11-25T00:00:00Z', providerCharge: 0 })!
    expect(r.amount).toBe(10000)
    expect(r.basis).toHaveLength(2)
  })

  it('a charge not in rupees, a missing departure, an unknown passenger type', () => {
    const usd = withSectors(raw => [JSON.parse(JSON.stringify(raw[0]).replace(/"currency":"INR"/g, '"currency":"USD"'))])
    const r1 = penaltyFromRules(usd, { paxType: 'ADT', cancelledAt: '2026-11-25T00:00:00Z', providerCharge: 0 })!
    expect(r1.amount).toBeNull()
    expect(r1.warnings[0]).toMatch(/in USD/)

    const noDate = withSectors(raw => [{ ...(raw[0] as object), traveldate: '' }])
    const r2 = penaltyFromRules(noDate, { paxType: 'ADT', cancelledAt: '2026-11-25T00:00:00Z', providerCharge: 0 })!
    expect(r2.amount).toBeNull()
    expect(r2.warnings[0]).toMatch(/no departure time/)

    // A child with no child rule: the adult's, said so.
    const child = at('2026-11-25T00:00:00Z', { paxType: 'Child' })!
    expect(child.amount).toBe(5000)
    expect(child.warnings[0]).toMatch(/no CHD rule; the adult rule is used/)
  })

  it('a sector leaving from abroad is flagged', () => {
    const abroad = withSectors(raw => [{ ...(raw[0] as object), origin: 'DXB' }])
    const r = penaltyFromRules(abroad, { paxType: 'ADT', cancelledAt: '2026-11-25T00:00:00Z', providerCharge: 0 })!
    expect(r.warnings.some(w => /India time/.test(w))).toBe(true)
  })

  it('nothing to work from: null', () => {
    expect(penaltyFromRules(null, { paxType: 'ADT', cancelledAt: '2026-11-25T00:00:00Z', providerCharge: 0 })).toBeNull()
    expect(penaltyFromRules(RULES, { paxType: 'ADT', cancelledAt: null, providerCharge: 0 })).toBeNull()
  })
})

describe('the pieces', () => {
  it('departure is read as India time', () => {
    expect(departureOf({ travelDate: '2026-12-07 07:30' })!.toISOString()).toBe('2026-12-07T02:00:00.000Z')
    expect(departureOf({ travelDate: 'soon' })).toBeNull()
  })

  it('passenger types', () => {
    expect(['ADT', 'Adult', '', null, 'CHD', 'Child', 'INF', 'infant'].map(rulePaxType)).toEqual(['ADT', 'ADT', 'ADT', 'ADT', 'CHD', 'CHD', 'INF', 'INF'])
  })

  it('on the 2-hour boundary the fee window wins over no-show; past the fetch-time bound the furthest window holds', () => {
    const cancel = RULES.sectors[0].pax[0].cancel
    expect(windowAt(cancel, 2)?.kind).toBe('before_departure')
    expect(windowAt(cancel, 1.5)?.kind).toBe('no_show')
    expect(windowAt(cancel, 470)?.kind).toBe('after_booking')
    expect(windowAt(cancel, 600)?.kind).toBe('before_departure')
  })
})
