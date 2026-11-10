import { describe, it, expect } from 'vitest'
import { airlinePnrFrom } from './airlinePnr'

describe('the airline PNR from a Ticket response', () => {
  it('one airline: the locator its legs share', () => {
    expect(airlinePnrFrom([{ AirLinePNR: 'I3UK8L' }, { AirLinePNR: 'I3UK8L' }])).toBe('I3UK8L')
  })

  it('several airlines: each locator once, in leg order', () => {
    expect(airlinePnrFrom([{ AirLinePNR: 'AB12CD' }, { AirLinePNR: ' ' }, { AirLinePNR: 'XY98ZW' }])).toBe('AB12CD / XY98ZW')
  })

  it('none issued, or no flight details at all: null', () => {
    expect(airlinePnrFrom([{ AirLinePNR: '' }, {}])).toBeNull()
    expect(airlinePnrFrom(null)).toBeNull()
    expect(airlinePnrFrom('nope')).toBeNull()
  })
})
