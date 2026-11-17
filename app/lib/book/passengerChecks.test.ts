import { describe, it, expect } from 'vitest'
import { ageOn, parseDay, passengerProblems, passportWarnings, mobileProblem, type CheckedPassenger } from './passengerChecks'

// ── Passengers as the airline will judge them ────────────────────────────────

const today = new Date(Date.UTC(2030, 0, 1))
const ctx = { travelDate: '2030-12-07', today }
const adult = (extra: Partial<CheckedPassenger> = {}): CheckedPassenger => ({ FirstName: 'Ravi', LastName: 'Kumar', PaxType: 'ADT', ...extra })
const fields = (ps: CheckedPassenger[], contact = {}) => passengerProblems(ps, contact, ctx).map(p => p.field)

describe('dates and ages', () => {
  it('reads DD/MM/YYYY and YYYY-MM-DD, and refuses dates that do not exist', () => {
    expect(parseDay('07/12/2030')?.toISOString().slice(0, 10)).toBe('2030-12-07')
    expect(parseDay('2030-12-07')?.toISOString().slice(0, 10)).toBe('2030-12-07')
    expect(parseDay('31/02/2030')).toBeNull()
    expect(parseDay('soon')).toBeNull()
  })
  it('counts whole years, the birthday itself included', () => {
    expect(ageOn(parseDay('07/12/2028')!, parseDay('2030-12-07')!)).toBe(2)
    expect(ageOn(parseDay('08/12/2028')!, parseDay('2030-12-07')!)).toBe(1)
  })
})

describe('passengerProblems', () => {
  it('a clean booking has none', () => {
    expect(passengerProblems([adult()], { Email: 'r@example.test', Mobile: '98765 43210' }, ctx)).toEqual([])
  })

  it('an infant is under 2 on the travel date, at the edge', () => {
    const lap = (dob: string) => [adult(), { FirstName: 'Baby', LastName: 'Kumar', PaxType: 'INF', DateOfBirth: dob }]
    expect(fields(lap('08/12/2028'))).toEqual([])            // 1 on the day
    expect(fields(lap('07/12/2028'))).toEqual(['dateOfBirth']) // turns 2 that day
    expect(fields([adult(), { FirstName: 'Baby', LastName: 'Kumar', PaxType: 'INF' }])).toEqual(['dateOfBirth'])
  })

  it('a child is 2 to 11 on the travel date', () => {
    const kid = (dob: string) => [adult(), { FirstName: 'Asha', LastName: 'Kumar', PaxType: 'CHD', DateOfBirth: dob }]
    expect(fields(kid('07/12/2028'))).toEqual([])            // 2 that day
    expect(fields(kid('08/12/2028'))).toEqual(['dateOfBirth']) // still 1
    expect(fields(kid('08/12/2018'))).toEqual([])            // 11
    expect(fields(kid('07/12/2018'))).toEqual(['dateOfBirth']) // 12 that day
  })

  it('an adult is 12 or older; nobody is born in the future; a date must be one', () => {
    expect(fields([adult({ DateOfBirth: '01/01/2020' })])).toEqual(['dateOfBirth'])
    expect(fields([adult({ DateOfBirth: '01/01/2031' })])).toEqual(['dateOfBirth'])
    expect(fields([adult({ DateOfBirth: '1980' })])).toEqual(['dateOfBirth'])
  })

  it('no more infants than adults', () => {
    const baby = (n: string) => ({ FirstName: n, LastName: 'Kumar', PaxType: 'INF', DateOfBirth: '01/06/2029' })
    const problems = passengerProblems([adult(), baby('Asha'), baby('Mira')], {}, ctx)
    expect(problems.map(p => p.field)).toEqual(['travellers'])
    expect(problems[0].error).toMatch(/2 infants need at least 2 adults \(this booking has 1\)/)
  })

  it('the same person twice', () => {
    const problems = passengerProblems([adult(), adult({ FirstName: ' ravi ' })], {}, ctx)
    expect(problems.map(p => p.field)).toEqual(['firstName'])
    expect(problems[0].error).toMatch(/Travellers 1 and 2 have the same name/)
  })

  it('a passport that expires before the flight', () => {
    expect(fields([adult({ PassportNumber: 'Z1', ExpiryDate: '06/12/2030' })])).toEqual(['passportExpiry'])
    expect(fields([adult({ PassportNumber: 'Z1', ExpiryDate: '07/12/2030' })])).toEqual([])
  })

  it('contact details that are not one', () => {
    expect(fields([adult()], { Email: 'ravi@', Mobile: '12345' })).toEqual(['email', 'mobile'])
    expect(mobileProblem('+44 7700 900123')).toBeNull()
    expect(mobileProblem('')).toBeNull()
  })

  it('names come first, marked as such, as before', () => {
    const [first] = passengerProblems([adult({ LastName: '00003' })], {}, ctx)
    expect(first).toMatchObject({ kind: 'name', field: 'lastName', passenger: 0 })
  })
})

describe('passportWarnings', () => {
  it('international only, within six months of travel', () => {
    const p = [adult({ PassportNumber: 'Z1', ExpiryDate: '01/03/2031' })]
    expect(passportWarnings(p, { ...ctx, international: true })).toHaveLength(1)
    expect(passportWarnings(p, { ...ctx, international: false })).toEqual([])
    expect(passportWarnings([adult({ PassportNumber: 'Z1', ExpiryDate: '01/09/2031' })], { ...ctx, international: true })).toEqual([])
  })
})
