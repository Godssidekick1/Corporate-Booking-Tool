// ── Approval categories ──────────────────────────────────────────────────────
// What a chain is assigned for. Pure -- no database -- so the TMC screens can
// import the one list instead of each keeping a copy (three did, and drifted).
//
// 'trip' is not a booking's category: it routes the trip SIGN-OFF -- the whole
// trip, approved once when it is ready (startApprovalForTrip), not each
// booking at booking time. categoryForTravelType never returns it.
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalCategory = 'air' | 'hotel' | 'misc' | 'trip'

// Every category, in the order screens should offer them.
export const APPROVAL_CATEGORIES: ApprovalCategory[] = ['air', 'hotel', 'misc', 'trip']

export const APPROVAL_CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  air: 'Flights',
  hotel: 'Hotels',
  misc: 'Everything else',
  trip: 'Trip sign-off',
}

// For a <select>: value + label, in order.
export const APPROVAL_CATEGORY_OPTIONS = APPROVAL_CATEGORIES.map(value => ({
  value, label: APPROVAL_CATEGORY_LABELS[value],
}))

// ── categoryForTravelType ──────────────────────────────────────────────────
// The only place travelType's finer granularity gets collapsed to a routing
// category. Anything starting with 'flight' is air, 'hotel' is hotel, and
// everything else (car_rental, misc expenses, and any future travel type
// nobody's thought of yet) defaults to misc rather than silently matching no
// bucket at all — which would mean no approval on a booking type nobody
// remembered to classify.
export function categoryForTravelType(travelType: string): ApprovalCategory {
  if (travelType.startsWith('flight')) return 'air'
  if (travelType.startsWith('hotel')) return 'hotel'
  return 'misc'
}

export function isApprovalCategory(value: string): value is ApprovalCategory {
  return (APPROVAL_CATEGORIES as string[]).includes(value)
}
