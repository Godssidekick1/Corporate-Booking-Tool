import { firstPassengerNameProblem } from './passengerNames'

// ── Passengers, as the airline will judge them ───────────────────────────────
// Everything an airline refuses about a passenger list, checked before the
// airline sees it, in words a traveller can act on. Airlines often refuse
// these with no reason at all (a "Failed" booking), which is the worst place
// to find out. One rule set, used by the passenger page as the details are
// entered and by the server (add-passenger, the passenger edit), so the two
// can never disagree.
//
//   names       letters only (passengerNames.ts)
//   ages        a child is 2-11 and an infant under 2 ON THE TRAVEL DATE, and
//               both need a date of birth; nobody is born in the future
//   infants     no more infants than adults (each sits on an adult's lap)
//   repeats     the same person twice in one booking
//   passport    when given, not expired by the travel date
//   contact     an email that is one, a mobile that is one
//
// Warnings (passportWarnings) never block: an international passport that
// expires within six months of travel, which many countries refuse at entry.
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckedPassenger {
  FirstName?: string | null
  MiddleName?: string | null
  LastName?: string | null
  DateOfBirth?: string | null   // DD/MM/YYYY
  PaxType?: string | null       // ADT | CHD | INF
  PassportNumber?: string | null
  ExpiryDate?: string | null    // DD/MM/YYYY
}

export type PassengerField = 'firstName' | 'middleName' | 'lastName' | 'dateOfBirth' | 'passportExpiry' | 'email' | 'mobile' | 'travellers'

export interface PassengerProblem {
  // name: a name the airline will not take (INVALID_PASSENGER_NAME, as
  // before); passenger: ages, infants, repeats, passport; contact.
  kind: 'name' | 'passenger' | 'contact'
  // Which traveller (0-based), or null for the booking as a whole (contact,
  // the count of infants).
  passenger: number | null
  field: PassengerField
  error: string
}

// "DD/MM/YYYY" or "YYYY-MM-DD" to a UTC date; null when it is not a date.
export function parseDay(value: string | null | undefined): Date | null {
  const v = (value ?? '').trim()
  let y: number, m: number, d: number
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v)
  if (match) { d = +match[1]; m = +match[2]; y = +match[3] } else {
    match = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
    if (!match) return null
    y = +match[1]; m = +match[2]; d = +match[3]
  }
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null
}

// Whole years between a birth date and a day.
export function ageOn(birth: Date, day: Date): number {
  let age = day.getUTCFullYear() - birth.getUTCFullYear()
  const before = day.getUTCMonth() < birth.getUTCMonth()
    || (day.getUTCMonth() === birth.getUTCMonth() && day.getUTCDate() < birth.getUTCDate())
  if (before) age--
  return age
}

const dayText = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const nameOf = (p: CheckedPassenger) =>
  [p.FirstName, p.MiddleName, p.LastName].map(s => (s ?? '').trim().toUpperCase()).filter(Boolean).join(' ')

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// A mobile: 10 digits (India), or + and 8-15 digits. Spaces and dashes allowed.
export function mobileProblem(raw: string | null | undefined): string | null {
  const v = (raw ?? '').replace(/[\s-]/g, '')
  if (!v) return null
  if (/^\d{10}$/.test(v) || /^\+\d{8,15}$/.test(v)) return null
  return `The mobile number “${raw}” doesn’t look right. Enter 10 digits, or + and the country code for a number outside India.`
}

export interface CheckContext {
  // The first flight's departure day (YYYY-MM-DD or DD/MM/YYYY).
  travelDate: string | null | undefined
  // Today, for "not born in the future" (tests pass a fixed day).
  today?: Date
}

export function passengerProblems(
  passengers: readonly CheckedPassenger[],
  contact: { Email?: string | null; Mobile?: string | null },
  ctx: CheckContext,
): PassengerProblem[] {
  const out: PassengerProblem[] = []
  const many = passengers.length > 1
  const who = (i: number) => (many ? `Traveller ${i + 1}: ` : '')
  const travel = parseDay(ctx.travelDate)
  const today = ctx.today ?? new Date()

  const name = firstPassengerNameProblem(passengers)
  if (name) out.push({ kind: 'name', passenger: name.passenger, field: name.field, error: name.error })

  passengers.forEach((p, i) => {
    const type = (p.PaxType ?? 'ADT').toUpperCase()
    const rawDob = (p.DateOfBirth ?? '').trim()
    const dob = parseDay(rawDob)
    if (rawDob && !dob) {
      out.push({ kind: 'passenger', passenger: i, field: 'dateOfBirth', error: `${who(i)}the date of birth “${rawDob}” isn’t a date. Use DD/MM/YYYY.` })
    } else if (!dob && (type === 'CHD' || type === 'INF')) {
      out.push({ kind: 'passenger', passenger: i, field: 'dateOfBirth', error: `${who(i)}a date of birth is needed for a ${type === 'CHD' ? 'child' : 'infant'}: airlines price and seat them by age.` })
    } else if (dob) {
      if (dob.getTime() > today.getTime()) {
        out.push({ kind: 'passenger', passenger: i, field: 'dateOfBirth', error: `${who(i)}the date of birth is in the future.` })
      } else if (travel) {
        const age = ageOn(dob, travel)
        if (type === 'INF' && age >= 2) {
          out.push({ kind: 'passenger', passenger: i, field: 'dateOfBirth', error: `${who(i)}an infant must be under 2 on the day of travel (${dayText(travel)}); this one will be ${age}. Book them as a child instead.` })
        } else if (type === 'CHD' && (age < 2 || age > 11)) {
          out.push({ kind: 'passenger', passenger: i, field: 'dateOfBirth', error: age < 2
            ? `${who(i)}a child must be at least 2 on the day of travel (${dayText(travel)}). Book them as an infant instead.`
            : `${who(i)}a child must be under 12 on the day of travel (${dayText(travel)}); this one will be ${age}. Book them as an adult instead.` })
        } else if (type === 'ADT' && age < 12) {
          out.push({ kind: 'passenger', passenger: i, field: 'dateOfBirth', error: `${who(i)}an adult must be 12 or older on the day of travel (${dayText(travel)}); this traveller will be ${age}. Search again with them as ${age < 2 ? 'an infant' : 'a child'}.` })
        }
      }
    }

    const expiry = parseDay(p.ExpiryDate)
    if ((p.PassportNumber ?? '').trim() && expiry && travel && expiry.getTime() < travel.getTime()) {
      out.push({ kind: 'passenger', passenger: i, field: 'passportExpiry', error: `${who(i)}the passport expires on ${dayText(expiry)}, before the flight on ${dayText(travel)}. Use a valid passport.` })
    }
  })

  const adults = passengers.filter(p => (p.PaxType ?? 'ADT').toUpperCase() === 'ADT').length
  const infants = passengers.filter(p => (p.PaxType ?? '').toUpperCase() === 'INF').length
  if (infants > adults) {
    out.push({ kind: 'passenger', passenger: null, field: 'travellers', error: `Each infant travels on an adult’s lap: ${infants} infants need at least ${infants} adults (this booking has ${adults}).` })
  }

  const seen = new Map<string, number>()
  passengers.forEach((p, i) => {
    const full = nameOf(p)
    if (!full) return
    const first = seen.get(full)
    if (first !== undefined) {
      out.push({ kind: 'passenger', passenger: i, field: 'firstName', error: `Travellers ${first + 1} and ${i + 1} have the same name (${full}). Airlines refuse the same person twice in one booking: check the names.` })
    } else seen.set(full, i)
  })

  const email = (contact.Email ?? '').trim()
  if (email && !EMAIL.test(email)) {
    out.push({ kind: 'contact', passenger: null, field: 'email', error: `The email “${email}” doesn’t look right. Check it: the airline sends the booking there.` })
  }
  const mobile = mobileProblem(contact.Mobile)
  if (mobile) out.push({ kind: 'contact', passenger: null, field: 'mobile', error: mobile })

  return out
}

// Not reasons to refuse, but worth saying before the trip: an international
// passport expiring within six months of travel.
export function passportWarnings(passengers: readonly CheckedPassenger[], ctx: CheckContext & { international: boolean }): string[] {
  const travel = parseDay(ctx.travelDate)
  if (!ctx.international || !travel) return []
  const sixMonths = new Date(Date.UTC(travel.getUTCFullYear(), travel.getUTCMonth() + 6, travel.getUTCDate()))
  const many = passengers.length > 1
  return passengers.flatMap((p, i) => {
    const expiry = parseDay(p.ExpiryDate)
    if (!(p.PassportNumber ?? '').trim() || !expiry || expiry.getTime() < travel.getTime() || expiry.getTime() >= sixMonths.getTime()) return []
    return [`${many ? `Traveller ${i + 1}: ` : ''}the passport expires on ${dayText(expiry)}, within six months of travel. Many countries refuse entry on such a passport; check the destination’s rules.`]
  })
}
