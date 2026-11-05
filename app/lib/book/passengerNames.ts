// ── Passenger names, as airlines take them ──────────────────────────────────
// Airline systems accept letters A–Z and spaces in a passenger's name, and
// nothing else. A name with a digit or a symbol passes every step until the
// last: pricing and passenger details succeed, then the Booking call fails
// with no error text at all (seen 2026-11-05: eight attempts for a passenger
// whose last name was "00003", each "Status: Failure, Error: null").
//
// So names are checked before they reach the airline -- on the details page
// as the traveller types, and again by the server (add-passenger and the
// passenger edit) -- and the message says exactly what is wrong and how to
// write it instead. One rule, shared, so the two can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

export type NameField = 'firstName' | 'middleName' | 'lastName'

const LABEL: Record<NameField, string> = {
  firstName: 'First name',
  middleName: 'Middle name',
  lastName: 'Last name',
}

export const NAME_MAX = 40

// Why a name part would be refused, in words a traveller can act on; null
// when it is fine. Middle names are optional; first and last are not.
export function passengerNameProblem(field: NameField, raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\s+/g, ' ')
  const label = LABEL[field]
  if (!value) return field === 'middleName' ? null : `${label} is required.`
  if (/\d/.test(value)) {
    return `${label} “${value}” contains digits. Airlines accept letters only: enter it exactly as on the passport or ID.`
  }
  if (/[^\x00-\x7F]/.test(value)) {
    return `${label} “${value}” has accented or non-English letters. Airlines accept A–Z only: write é as e, ñ as n, and so on.`
  }
  const symbol = value.match(/[^A-Za-z ]/)
  if (symbol) {
    return `${label} “${value}” contains “${symbol[0]}”. Airlines accept letters and spaces only: leave out dots, hyphens and apostrophes (O’Brien becomes OBrien).`
  }
  if (field === 'lastName' && value.replace(/ /g, '').length < 2) {
    return 'Airlines need a last name of at least 2 letters. A traveller with only one name enters it as both first and last name.'
  }
  if (value.length > NAME_MAX) return `${label} can be at most ${NAME_MAX} characters.`
  return null
}

// Every problem in one passenger's name, by field.
export function passengerNameProblems(p: {
  firstName?: string | null; middleName?: string | null; lastName?: string | null
}): Partial<Record<NameField, string>> {
  const out: Partial<Record<NameField, string>> = {}
  for (const field of ['firstName', 'middleName', 'lastName'] as const) {
    const problem = passengerNameProblem(field, p[field])
    if (problem) out[field] = problem
  }
  return out
}

// The first problem among the passengers sent to the airline (the provider's
// PassengerDetails shape), for the server's refusal: which traveller, which
// field, and why.
export function firstPassengerNameProblem(
  details: readonly { FirstName?: string | null; MiddleName?: string | null; LastName?: string | null }[]
): { passenger: number; field: NameField; error: string } | null {
  for (const [i, d] of details.entries()) {
    const problems = passengerNameProblems({ firstName: d.FirstName, middleName: d.MiddleName, lastName: d.LastName })
    const field = (['firstName', 'middleName', 'lastName'] as const).find(f => problems[f])
    if (field) {
      const who = details.length > 1 ? `Traveller ${i + 1}: ` : ''
      return { passenger: i, field, error: `${who}${problems[field]}` }
    }
  }
  return null
}
