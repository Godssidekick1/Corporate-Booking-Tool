import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flowStorage, type OnBehalf } from '@/app/lib/book/flowStorage'

// The booking flow's tab storage outlives the account that filled it. A choice
// of whom to book for must only ever be honoured for the person who made it:
// a corporate admin signing in to a tab the travel desk used must book for
// themself, not for the desk's last traveller (who is in the same company, so
// the server would accept the booking).

class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  get length() { return this.m.size }
}

function storage(): MemoryStorage {
  const s = new MemoryStorage()
  // Object.keys(sessionStorage) lists the stored keys in a browser.
  return new Proxy(s, { ownKeys: t => [...(t as unknown as { m: Map<string, string> }).m.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) })
}

const DESK = '00000000-0000-0000-0000-00000000d001'
const ADMIN = '00000000-0000-0000-0000-00000000a001'

const forTraveller = (bookerId: string): OnBehalf => ({
  bookerId, travellerId: '00000000-0000-0000-0000-00000000t010', name: 'Traveller 10',
  clientName: 'Large Corp', bandCode: 'L3', policy: 'approvals', home: '/tmc/book',
})

describe('flowStorage: booking for someone belongs to whoever chose it', () => {
  beforeEach(() => { vi.stubGlobal('window', { sessionStorage: storage() }) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('is honoured for the account that chose the traveller', () => {
    flowStorage.claim(DESK)
    flowStorage.setOnBehalf(forTraveller(DESK))
    expect(flowStorage.onBehalf()?.name).toBe('Traveller 10')
    expect(flowStorage.travellerId()).toBe(forTraveller(DESK).travellerId)
    expect(flowStorage.exits().home.href).toBe('/tmc/book')
  })

  it('another account in the same tab books for itself, and the desk flow is gone', () => {
    flowStorage.claim(DESK)
    flowStorage.setOnBehalf(forTraveller(DESK))
    flowStorage.setTripId('trip-of-traveller-10')

    flowStorage.claim(ADMIN)
    expect(flowStorage.onBehalf()).toBeNull()
    expect(flowStorage.travellerId()).toBeUndefined()
    expect(flowStorage.getTripId()).toBeNull()
    expect(flowStorage.exits().home.href).toBe('/dashboard')
  })

  it('fails closed before anyone has claimed the tab (a page read before /api/me answers)', () => {
    flowStorage.setOnBehalf(forTraveller(DESK))
    expect(flowStorage.onBehalf()).toBeNull()
    expect(flowStorage.travellerId()).toBeUndefined()
  })

  it('a choice saved before bookers were recorded is never honoured', () => {
    const { bookerId: _dropped, ...legacy } = forTraveller(DESK)
    void _dropped
    window.sessionStorage.setItem('cbt:book:onBehalf', JSON.stringify(legacy))
    flowStorage.claim(ADMIN)
    expect(flowStorage.onBehalf()).toBeNull()
    expect(window.sessionStorage.getItem('cbt:book:onBehalf')).toBeNull()
  })

  it('the first claim after sign-in keeps the trip just picked', () => {
    flowStorage.setTripId('admins-own-trip')
    flowStorage.claim(ADMIN)
    expect(flowStorage.getTripId()).toBe('admins-own-trip')
  })

  // add-passenger refuses a trip that is not the traveller's ("Trip not found
  // or not owned by you"): an admin's own trip must never ride along into a
  // booking for a colleague.
  it("an admin's own trip is not sent while booking for a colleague, and comes back for themself", () => {
    flowStorage.claim(ADMIN)
    flowStorage.setTripId('admins-own-trip', null)      // + Add flight on their trip
    flowStorage.setOnBehalf({ ...forTraveller(ADMIN), home: '/bookings' })
    expect(flowStorage.getTripId()).toBeNull()
    flowStorage.setOnBehalf(null)                         // back to "Me"
    expect(flowStorage.getTripId()).toBe('admins-own-trip')
  })

  it("the colleague's trip is sent for the colleague only", () => {
    flowStorage.claim(ADMIN)
    flowStorage.setOnBehalf({ ...forTraveller(ADMIN), home: '/bookings' })
    flowStorage.setTripId('colleagues-trip', forTraveller(ADMIN).travellerId)
    expect(flowStorage.getTripId()).toBe('colleagues-trip')
    flowStorage.setOnBehalf(null)
    expect(flowStorage.getTripId()).toBeNull()
  })

  it('"No trip" clears the trip chosen before it', () => {
    flowStorage.claim(ADMIN)
    flowStorage.setTripId('some-trip', null)
    flowStorage.setTripId(null)
    expect(flowStorage.getTripId()).toBeNull()
  })

  it('a bare trip id stored before trips recorded whose they are counts as one\'s own', () => {
    flowStorage.claim(ADMIN)
    window.sessionStorage.setItem('cbt:book:tripId', JSON.stringify('old-own-trip'))
    expect(flowStorage.getTripId()).toBe('old-own-trip')
    flowStorage.setOnBehalf({ ...forTraveller(ADMIN), home: '/bookings' })
    expect(flowStorage.getTripId()).toBeNull()
  })

  it('sign-in and sign-out (clearAll) forget the owner too', () => {
    flowStorage.claim(DESK)
    flowStorage.setOnBehalf(forTraveller(DESK))
    flowStorage.clearAll()
    flowStorage.setOnBehalf(forTraveller(DESK))
    expect(flowStorage.onBehalf()).toBeNull()
  })
})
