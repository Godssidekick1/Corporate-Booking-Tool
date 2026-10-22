import { describe, it, expect, vi } from 'vitest'
import { AmadeusError } from '@/app/lib/amadeus/client'
import { failureKind, plainMessage, providerFailure, supportReference } from './providerErrors'

const err = (message: string, requestId = '3f2a9c1b-0000-4000-8000-000000000000') =>
  new AmadeusError(message, 'E1', 'Cat', { Status: 'Failure', Error: { Description: message } }, requestId, { secret: 'body' })

const traveller = { employee: { role: 'employee' } } as never
const desk = { employee: { role: 'tc' } } as never

describe('provider errors', () => {
  it('tells the kinds of failure apart from the provider’s text', () => {
    expect(failureKind(err('Amadeus FlightAvailability failed: Result Not Found'))).toBe('no_results')
    expect(failureKind(err('Amadeus Pricing failed: Fare Not Found'))).toBe('fare_gone')
    expect(failureKind(err('Amadeus Booking failed: Fare no longer available'))).toBe('fare_gone')
    expect(failureKind(err('Amadeus Pricing failed: Result Session Expired'))).toBe('expired')
    // An outage is not a sold-out fare.
    expect(failureKind(err('Amadeus Booking failed: Service not available'))).toBe('generic')
  })

  it('a plain message per step; a gone fare only where choosing another flight helps', () => {
    expect(plainMessage(err('Fare Not Found'), 'booking')).toMatch(/^This fare is no longer available/)
    expect(plainMessage(err('Fare Not Found'), 'ticket')).toMatch(/^The ticket could not be issued/)
    expect(plainMessage(err('Session expired'), 'price')).toBe('This search has expired. Please search again.')
    expect(plainMessage(err('Queue busy'), 'search')).toMatch(/^We couldn’t get flights/)
  })

  it('a traveller gets the plain line and a reference, nothing of the provider', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = providerFailure(err('Amadeus FlightAvailability failed: Queue busy'), 'search', traveller)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toEqual({
      error: 'We couldn’t get flights from the airline just now. Please try again in a moment. (Reference 3F2A9C1B)',
      code: 'PROVIDER_FAILED', reference: '3F2A9C1B',
    })
    expect(JSON.stringify(body)).not.toMatch(/amadeus|flightavailability|queue busy|secret|requestId/i)
  })

  it('the travel desk also gets the provider’s message and the full request id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = await providerFailure(err('Amadeus Ticket failed: Queue busy'), 'ticket', desk).json()
    expect(body.provider).toEqual({
      message: 'Amadeus Ticket failed: Queue busy', code: 'E1', requestId: '3f2a9c1b-0000-4000-8000-000000000000',
    })
    // Never the request or response payloads, even for the desk.
    expect(JSON.stringify(body)).not.toMatch(/secret/)
  })

  it('logs everything needed to investigate, once, under the full id', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.mockClear()
    providerFailure(err('Amadeus Booking failed: Queue busy'), 'booking', traveller)
    expect(log).toHaveBeenCalledTimes(1)
    const text = String(log.mock.calls[0][1])
    expect(text).toContain('3f2a9c1b-0000-4000-8000-000000000000')
    expect(text).toContain('Queue busy')
    expect(supportReference(err('x', ''))).toBeNull()
  })
})
