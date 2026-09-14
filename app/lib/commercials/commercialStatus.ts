// ── Commercial rule status ───────────────────────────────────────────────────
// Derived from the `active` flag AND the validity window, so a rule that lapsed
// eight months ago cannot read as live because somebody left a checkbox ticked.
// Same reasoning as dealCodeStatus.ts, and the same shape.
//
// SIMPLER THAN A DEAL CODE, on purpose. A deal has a sales window and a travel
// window, and needs a `sales_closed` state for the gap between them — nothing
// new can be sold but tickets already sold are still travelling. A commercial
// rule has ONE window: it either applies to the booking being priced or it does
// not. Giving it two lifecycles would be a second thing to keep in agreement
// with the first.
// ─────────────────────────────────────────────────────────────────────────────

export type CommercialStatus = 'inactive' | 'scheduled' | 'active' | 'expired'

export interface CommercialWindows {
  active: boolean
  valid_from?: string | null
  valid_to?: string | null
}

export const COMMERCIAL_STATUS_LABELS: Record<CommercialStatus, string> = {
  inactive:  'Inactive',
  scheduled: 'Scheduled',
  active:    'Active',
  expired:   'Expired',
}

// Compared as YYYY-MM-DD strings rather than Date objects. The columns are
// `date`, not `timestamptz` — parsing them into Dates drags the browser's
// timezone in and makes a rule expire a day early for anyone west of UTC.
// Lexicographic comparison on ISO dates is the same as chronological.
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null
  return value.slice(0, 10)
}

export function commercialStatus(
  rule: CommercialWindows,
  asOf: string = today()
): CommercialStatus {
  if (!rule.active) return 'inactive'

  const on = dateOnly(asOf)!
  const from = dateOnly(rule.valid_from)
  const to = dateOnly(rule.valid_to)

  if (from && on < from) return 'scheduled'
  if (to && on > to) return 'expired'

  return 'active'
}

// ── isApplicable ─────────────────────────────────────────────────────────────
// Whether a rule may be applied to a booking priced on a given date.
//
// Kept separate from `commercialStatus` for the same reason `isSellable` is
// separate from `dealCodeStatus`: status is what a screen renders, this is what
// the engine asks. They happen to agree today — there is no amber state here —
// but a future one (a rule winding down, say) must not silently start applying
// itself because a label was added.
// ─────────────────────────────────────────────────────────────────────────────
export function isApplicable(rule: CommercialWindows, pricedOn: string = today()): boolean {
  return commercialStatus(rule, pricedOn) === 'active'
}
