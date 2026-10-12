// ── Why the desk booked outside policy ───────────────────────────────────────
// At a CBT-only client the travel desk books for people, policy is guidance
// rather than an approval gate, and an amber or red fare needs one of these
// before it can be booked. Kept free of imports so the booking screens and the
// add-passenger route share one list; the database holds the same codes as a
// check constraint (20261013000000_book_on_behalf).
// ─────────────────────────────────────────────────────────────────────────────

export const POLICY_REASONS = [
  { code: 'client_instruction', label: 'Instructed by the client' },
  { code: 'no_compliant_option', label: 'No in-policy option available' },
  { code: 'schedule_need', label: 'Schedule or timing need' },
  { code: 'lower_total_cost', label: 'Lower total trip cost' },
  { code: 'other', label: 'Other (explain)' },
] as const

export type PolicyReasonCode = typeof POLICY_REASONS[number]['code']

export function isPolicyReasonCode(v: unknown): v is PolicyReasonCode {
  return POLICY_REASONS.some(r => r.code === v)
}

// A reason the desk may book on: a known code, and a note when it is 'other'.
export function reasonProblem(code: unknown, note: unknown): string | null {
  if (!isPolicyReasonCode(code)) return 'Choose why this booking goes ahead outside policy.'
  if (code === 'other' && !(typeof note === 'string' && note.trim())) return 'Explain the reason for "Other".'
  return null
}
