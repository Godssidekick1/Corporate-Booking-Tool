// ── Deal code status ─────────────────────────────────────────────────────────
// The screen this replaces shows `active` as a checkbox, which lets a deal that
// expired eight months ago read as live. Status is derived from the flag AND
// both windows, and the derived value is what the UI shows.
//
// "Sales closed" is the state no current screen has and the one that matters
// most in practice: the sales window has ended so nothing new can be booked,
// but the travel window is still open, so tickets already sold are still
// travelling and the deal must not be filed away as dead.
// ─────────────────────────────────────────────────────────────────────────────

export type DealCodeStatus = 'inactive' | 'scheduled' | 'active' | 'sales_closed' | 'expired'

export interface DealCodeWindows {
  active: boolean
  sales_from?: string | null
  sales_to?: string | null
  travel_from?: string | null
  travel_to?: string | null
}

export const STATUS_LABELS: Record<DealCodeStatus, string> = {
  inactive:     'Inactive',
  scheduled:    'Scheduled',
  active:       'Active',
  sales_closed: 'Sales closed',
  expired:      'Expired',
}

// Compared as YYYY-MM-DD strings rather than Date objects. The columns are
// `date`, not `timestamptz` — parsing them into Dates drags the browser's
// timezone in and makes a deal expire a day early for anyone west of UTC.
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

export function dealCodeStatus(deal: DealCodeWindows, asOf: string = today()): DealCodeStatus {
  if (!deal.active) return 'inactive'

  const on = dateOnly(asOf)!
  const salesFrom = dateOnly(deal.sales_from)
  const salesTo = dateOnly(deal.sales_to)
  const travelTo = dateOnly(deal.travel_to)

  if (salesFrom && on < salesFrom) return 'scheduled'

  if (salesTo && on > salesTo) {
    // Travel still open -> sellable no longer, but live for anyone already
    // ticketed. No travel window at all means travel was never bounded, so it
    // stays in that state rather than being called expired.
    if (!travelTo || on <= travelTo) return 'sales_closed'
    return 'expired'
  }

  return 'active'
}

// Whether a deal may be applied to a booking made today for travel on a given
// date. Distinct from status on purpose: `sales_closed` reads as amber in the
// UI but is a hard no here, and a deal can be `active` overall yet still not
// apply to a specific itinerary whose departure falls outside the travel window.
export function isSellable(
  deal: DealCodeWindows,
  bookingDate: string,
  departureDate: string | null
): boolean {
  if (!deal.active) return false

  const booked = dateOnly(bookingDate)!
  const salesFrom = dateOnly(deal.sales_from)
  const salesTo = dateOnly(deal.sales_to)

  if (salesFrom && booked < salesFrom) return false
  if (salesTo && booked > salesTo) return false

  const departure = dateOnly(departureDate)
  const travelFrom = dateOnly(deal.travel_from)
  const travelTo = dateOnly(deal.travel_to)

  // No departure date to test against -> the travel window cannot be evaluated.
  // Treated as passing rather than failing: the sales window has already been
  // checked, and refusing here would silently drop every deal on any flow that
  // does not carry a departure date.
  if (!departure) return true

  if (travelFrom && departure < travelFrom) return false
  if (travelTo && departure > travelTo) return false

  return true
}
