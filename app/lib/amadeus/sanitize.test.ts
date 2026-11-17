import { describe, it, expect } from 'vitest'
import { sanitizeAmadeusDiagnostic } from './client'

// ── What a log line may carry of an airline request or answer ─────────────────
// Every request and every failure's raw answer is logged. Shaped like the
// Booking failure of 17 Nov 2026, with made-up values.

const FAILED_BOOKING = {
  Status: 'Failure',
  ReferenceNo: 'ARRF00001',
  SessionID: 'sess-123',
  AirBookingResponse: [{
    Origin: 'BLR', Destination: 'DEL', BookingStatus: 'Failed',
    FlightDetails: [{ FlightNumber: '2654', AirLineCode: 'AI', DepartDateTime: '2030-11-25T07:00:00' }],
    CustomerInfo: {
      Email: 'traveller@example.test', Mobile: '9000000000', Phone: null, Address: '1 Road', ZipCode: '110001',
      PassengerDetails: [{
        Title: 'MR', FirstName: 'Asha', MiddleName: '', LastName: 'Rao', DateOfBirth: '01/01/1980', Gender: 'M',
        PaxType: 'ADT', PassportNumber: 'Z1234567', ExpiryDate: '01/01/2035', Nationality: 'IN', IssuingCountry: 'IN',
        FfNo: 'AI123', FrequentFlyerAirline: 'AI', Status: 'Failed',
      }],
    },
  }],
}

describe('sanitizeAmadeusDiagnostic', () => {
  const out = JSON.stringify(sanitizeAmadeusDiagnostic(FAILED_BOOKING))

  it('removes the passenger’s personal details and the session, at any depth', () => {
    for (const secret of ['traveller@example.test', '9000000000', '1 Road', '110001', 'Asha', 'Rao', '01/01/1980',
      'Z1234567', '01/01/2035', 'AI123', 'sess-123']) {
      expect(out, secret).not.toContain(secret)
    }
  })

  it('keeps what a failure is diagnosed by', () => {
    for (const kept of ['ARRF00001', 'BLR', 'DEL', '2654', 'Failed', 'ADT', '2030-11-25T07:00:00']) {
      expect(out, kept).toContain(kept)
    }
  })

  it('removes sign-in credentials', () => {
    const auth = JSON.stringify(sanitizeAmadeusDiagnostic({ UserName: 'agent', Password: 'secret' }))
    expect(auth).not.toContain('agent')
    expect(auth).not.toContain('secret')
  })
})
