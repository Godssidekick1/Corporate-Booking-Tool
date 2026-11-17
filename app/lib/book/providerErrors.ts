import util from 'node:util'
import { AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
import type { Principal } from '@/app/lib/auth/session'

// ── When the airline system says no ──────────────────────────────────────────
// Travellers and approvers are told what happened in plain words, per step,
// with a short reference to quote to the travel desk. They are never shown
// the provider's name, endpoint, error text, request id or payload: those
// read as "the site is broken" and give away how it is built.
//
// Everything a person needs to investigate goes to the server log, once,
// under the full request id (the reference is its first eight characters).
// TMC staff, who do the investigating, also get the provider's own message
// and the full id in the response (`provider`).
// ─────────────────────────────────────────────────────────────────────────────

export type BookingStep = 'search' | 'price' | 'passenger' | 'passenger_edit' | 'booking' | 'ticket' | 'cancel'

const GENERIC: Record<BookingStep, string> = {
  search: 'We couldn’t get flights from the airline just now. Please try again in a moment.',
  price: 'We couldn’t confirm the price of this fare just now. Please try again, or choose another flight.',
  passenger: 'We couldn’t send the passenger details to the airline just now. Please try again.',
  passenger_edit: 'We couldn’t save the corrected details with the airline just now. Please try again.',
  booking: 'The airline did not confirm this booking. Please try again. If it happens again, contact your travel desk.',
  ticket: 'The ticket could not be issued just now. Please try again. If it happens again, contact your travel desk.',
  cancel: 'The airline did not confirm the cancellation. Your booking is unchanged. Please try again, or contact your travel desk.',
}

const FARE_GONE = 'This fare is no longer available. Go back to the results and choose another flight.'
const EXPIRED = 'This search has expired. Please search again.'

// What kind of failure the provider's text describes. Only the kinds with a
// different message for the person are told apart; the rest is "generic".
export type FailureKind = 'no_results' | 'fare_gone' | 'expired' | 'generic'

export function failureKind(err: AmadeusError): FailureKind {
  const text = `${err.message} ${err.code}`.toLowerCase()
  if (/result not found|no (flight|result|availability)s? (found|available)/.test(text)) return 'no_results'
  if (/fare not found|fare (is )?no longer|fare not available|seats? not available|sold out|no seats? (left|available)/.test(text)) return 'fare_gone'
  if (/session|expired|invalid key/.test(text)) return 'expired'
  return 'generic'
}

export function plainMessage(err: AmadeusError, step: BookingStep): string {
  const kind = failureKind(err)
  if (kind === 'fare_gone' && step !== 'search' && step !== 'passenger_edit' && step !== 'ticket' && step !== 'cancel') return FARE_GONE
  if (kind === 'expired' && (step === 'price' || step === 'passenger')) return EXPIRED
  return GENERIC[step]
}

// ── The traveller already on this flight ───────────────────────────────────
// Airlines refuse a further booking of a person already booked on a flight,
// often with no reason given. Said the same way where add-passenger warns
// before the airline is asked, and where the booking route explains a refusal.
export interface SameFlight { flight: string; day: string; others: { pnr: string | null }[] }

const flightText = (f: string) => f.replace(/^([A-Z0-9]{2})(\d+)$/, '$1 $2')
function dayText(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function heldText(same: SameFlight): string {
  const n = same.others.length
  const pnrs = same.others.map(o => o.pnr).filter(Boolean)
  const count = n === 1 ? 'a booking' : `${n} bookings`
  return `${count} on ${flightText(same.flight)} on ${dayText(same.day)}${pnrs.length ? ` (PNR ${pnrs.join(', ')})` : ''}`
}

// After the airline turned the booking down.
export function alreadyOnFlightMessage(same: SameFlight): string {
  return `The airline turned this booking down. This traveller already has ${heldText(same)}, and airlines refuse a further booking of the same person on one flight. Use the existing booking, or cancel it first if this one is meant to replace it.`
}

// Before the airline is asked (add-passenger): a question, answered once.
export function alreadyOnFlightQuestion(same: SameFlight): string {
  return `This traveller already has ${heldText(same)}. Airlines usually refuse another booking of the same person on one flight, so this one may be turned down when it is confirmed. Book it anyway?`
}

// A short reference a traveller can read out, matching the logged request id.
export function supportReference(err: AmadeusError): string | null {
  return err.requestId ? err.requestId.replace(/-/g, '').slice(0, 8).toUpperCase() : null
}

export function isDeskStaff(user: Pick<Principal, 'employee'>): boolean {
  const role = user.employee?.role
  return role === 'tmc_admin' || role === 'tc'
}

// Logs the failure in full and answers with what this person may see.
export function providerFailure(
  err: AmadeusError,
  step: BookingStep,
  user: Pick<Principal, 'employee'>,
  extra: Record<string, unknown> = {},
  // A cause worked out from our own records when the airline gave none (the
  // traveller already on this flight, say): said in place of the generic line,
  // which would wrongly suggest trying again.
  explained?: { message: string; code: string },
): Response {
  const reference = supportReference(err)
  console.error(`[provider] ${step} failed`, util.inspect({
    reference,
    requestId: err.requestId,
    code: err.code,
    category: err.category,
    message: err.message,
    request: sanitizeAmadeusDiagnostic(err.requestBody),
    raw: sanitizeAmadeusDiagnostic(err.raw),
  }, { depth: null, colors: false }))

  const message = explained?.message ?? plainMessage(err, step)
  return Response.json({
    error: reference ? `${message} (Reference ${reference})` : message,
    code: explained?.code ?? (failureKind(err) === 'fare_gone' ? 'FARE_UNAVAILABLE' : 'PROVIDER_FAILED'),
    reference,
    ...extra,
    ...(isDeskStaff(user) ? { provider: { message: err.message, code: err.code || null, requestId: err.requestId ?? null } } : {}),
  }, { status: 502 })
}
