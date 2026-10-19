import type { Queryable } from '@/app/lib/db'
import type { ClientGates } from '@/app/lib/clients/clientGates'
import { resolveEffectivePolicy } from './resolveEffectivePolicy'
import { FIELD_DEFAULTS } from '@/app/lib/policy/fields'

// ── bookingRightsFor ─────────────────────────────────────────────────────────
// May this traveller book a personal trip, or a booking for a guest? Two
// answers, both needed:
//   - the company (Corporate Settings) allows it at all -- the master switch;
//   - the traveller's policy group allows it for their band
//     (personal_trips_allowed, guest_bookings_allowed).
// A rule the group has not saved reads as the editor shows it (FIELD_DEFAULTS:
// personal No, guests Yes), so what a TMC sees is what is enforced.
//
// With no policy to ask -- policy control switched off, or the traveller
// unresolved (no band, no group) -- the company switch alone decides: a
// missing policy does not take away what the company allowed.
// ─────────────────────────────────────────────────────────────────────────────

export type Right = { allowed: true } | { allowed: false; by: 'company' | 'policy' }

export interface BookingRights {
  personal: Right
  guest: Right
}

const ALLOWED: Right = { allowed: true }

export async function bookingRightsFor(
  db: Queryable,
  travellerId: string,
  gates: Pick<ClientGates, 'policyControlling' | 'personalBookingsAllowed' | 'guestBookingsAllowed'>,
): Promise<BookingRights> {
  const company = {
    personal: gates.personalBookingsAllowed,
    guest: gates.guestBookingsAllowed,
  }
  // Nothing the company allows: the policy is not worth reading.
  if (!company.personal && !company.guest) {
    return { personal: { allowed: false, by: 'company' }, guest: { allowed: false, by: 'company' } }
  }

  let limits: Record<string, number | boolean> | null = null
  if (gates.policyControlling) {
    const policy = await resolveEffectivePolicy(db, travellerId, 'flight')
    if (policy.ok) limits = policy.limits
  }

  const right = (companyAllows: boolean, key: 'personal_trips_allowed' | 'guest_bookings_allowed'): Right => {
    if (!companyAllows) return { allowed: false, by: 'company' }
    if (!limits) return ALLOWED
    const rule = limits[key] ?? FIELD_DEFAULTS[key]
    return rule === false ? { allowed: false, by: 'policy' } : ALLOWED
  }

  return {
    personal: right(company.personal, 'personal_trips_allowed'),
    guest: right(company.guest, 'guest_bookings_allowed'),
  }
}
