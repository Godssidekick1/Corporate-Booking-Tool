import { describe, it, expect } from 'vitest'
import { passengerNameProblem, passengerNameProblems, firstPassengerNameProblem } from './passengerNames'
import { silentFailure } from '@/app/lib/amadeus/client'

describe('passenger names, as airlines take them', () => {
  it('accepts letters and spaces, and an empty middle name', () => {
    expect(passengerNameProblems({ firstName: 'Ayush', middleName: '', lastName: 'Chopra' })).toEqual({})
    expect(passengerNameProblems({ firstName: 'Mary Ann', middleName: 'Rose', lastName: 'Van der Berg' })).toEqual({})
    expect(passengerNameProblem('firstName', '  Ravi   Kumar ')).toBeNull()
  })

  it('refuses digits, saying so: the demo passenger whose bookings failed silently', () => {
    expect(passengerNameProblem('lastName', '00003')).toBe(
      'Last name “00003” contains digits. Airlines accept letters only: enter it exactly as on the passport or ID.')
    expect(passengerNameProblem('middleName', 'Traveller 10')).toMatch(/^Middle name “Traveller 10” contains digits/)
  })

  it('refuses accents and symbols, and says how to write the name instead', () => {
    expect(passengerNameProblem('firstName', 'José')).toMatch(/accented or non-English letters.*write é as e/)
    expect(passengerNameProblem('lastName', "O'Brien")).toMatch(/contains “'”.*leave out dots, hyphens and apostrophes/)
    expect(passengerNameProblem('lastName', 'Al-Hassan')).toMatch(/contains “-”/)
  })

  it('first and last are required; a last name needs two letters', () => {
    expect(passengerNameProblem('firstName', ' ')).toBe('First name is required.')
    expect(passengerNameProblem('lastName', null)).toBe('Last name is required.')
    expect(passengerNameProblem('lastName', 'K')).toMatch(/at least 2 letters/)
    expect(passengerNameProblem('firstName', 'K')).toBeNull()
  })

  it('the server form names the traveller when there are several', () => {
    expect(firstPassengerNameProblem([{ FirstName: 'Ravi', LastName: 'Kumar' }])).toBeNull()
    expect(firstPassengerNameProblem([{ FirstName: 'Admin', MiddleName: 'Demo Client', LastName: '00003' }]))
      .toMatchObject({ passenger: 0, field: 'lastName', error: expect.stringMatching(/^Last name “00003”/) })
    expect(firstPassengerNameProblem([{ FirstName: 'Ravi', LastName: 'Kumar' }, { FirstName: 'S2', LastName: 'Rao' }]))
      .toMatchObject({ passenger: 1, field: 'firstName', error: expect.stringMatching(/^Traveller 2: First name “S2”/) })
  })
})

describe('a provider failure with no reason given', () => {
  it('is put into words from the response (the shape Booking returned on 2026-11-05)', () => {
    expect(silentFailure({
      Status: 'Failure', Error: null,
      AirBookingResponse: [{
        BookingStatus: 'Failed',
        ProviderDetails: { Tid: '82066-FQ', Status: 'Failed', Name: '', Info: '' },
        CustomerInfo: { PassengerDetails: [{ FirstName: 'Admin', MiddleName: 'Demo Client', LastName: '00003', Status: 'Failed' }] },
      }],
    })).toBe('no reason given by the provider (booking Failed; provider status Failed; passenger ADMIN DEMO CLIENT 00003: Failed)')
    expect(silentFailure({ Status: 'Failure', Error: null })).toBe('no reason given by the provider')
  })
})
