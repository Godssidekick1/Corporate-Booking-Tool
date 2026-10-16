// ── Trip and booking status, as people read them ─────────────────────────────
// One map for every trip screen (My trips, the trips page, the trip page, the
// desk). They used to keep their own and disagreed: 'open' read "Draft" on one
// page and "Planning" on the next.
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusMeta { label: string; color: string; bg: string }

const GREY: StatusMeta = { label: '', color: '#6B7280', bg: '#F3F4F6' }

const TRIP: Record<string, StatusMeta> = {
  open:      { label: 'Planning',  color: '#92400E', bg: '#FEF3C7' },
  active:    { label: 'Active',    color: '#1E40AF', bg: '#DBEAFE' },
  completed: { label: 'Completed', color: '#166534', bg: '#DCFCE7' },
  cancelled: { label: 'Cancelled', color: '#6B7280', bg: '#F3F4F6' },
}

// The sign-off. 'none' has no pill: nothing was asked.
const SIGN_OFF: Record<string, StatusMeta> = {
  pending:       { label: 'Awaiting sign-off',   color: '#92400E', bg: '#FEF3C7' },
  approved:      { label: 'Signed off',          color: '#166534', bg: '#DCFCE7' },
  rejected:      { label: 'Sign-off rejected',   color: '#991B1B', bg: '#FEE2E2' },
  misconfigured: { label: 'Sign-off not set up', color: '#991B1B', bg: '#FEE2E2' },
}

const BOOKING: Record<string, StatusMeta> = {
  ticketed:              { label: 'Ticketed',         color: '#166534', bg: '#DCFCE7' },
  held:                  { label: 'Booked',           color: '#1E40AF', bg: '#DBEAFE' },
  passenger_added:       { label: 'In progress',      color: '#92400E', bg: '#FEF3C7' },
  priced:                { label: 'In progress',      color: '#92400E', bg: '#FEF3C7' },
  not_evaluated:         { label: 'Pending policy',   color: '#92400E', bg: '#FEF3C7' },
  pending_approval:      { label: 'Pending approval', color: '#92400E', bg: '#FEF3C7' },
  approved:              { label: 'Approved',         color: '#1E40AF', bg: '#DBEAFE' },
  approval_misconfigured:{ label: 'Approval not set up', color: '#991B1B', bg: '#FEE2E2' },
  rejected:              { label: 'Rejected',         color: '#991B1B', bg: '#FEE2E2' },
  failed:                { label: 'Failed',           color: '#991B1B', bg: '#FEE2E2' },
  cancelled:             { label: 'Cancelled',        color: '#6B7280', bg: '#F3F4F6' },
}

export const tripStatus = (s: string): StatusMeta => TRIP[s] ?? { ...GREY, label: s }
export const signOffStatus = (s: string): StatusMeta | null => SIGN_OFF[s] ?? null
export const bookingStatus = (s: string): StatusMeta => BOOKING[s] ?? { ...GREY, label: s.replace(/_/g, ' ') }

// Where a booking goes when clicked -- the step it is sitting at, so a trip
// list doubles as a resume point. Failed, cancelled, rejected and
// misconfigured go to the confirm page, which explains each and offers a way
// out (the ticket page bounces them to the dashboard).
export function bookingHref(id: string, status: string): string {
  return status === 'ticketed' || status === 'held' ? `/book/ticket/${id}` : `/book/confirm/${id}`
}

export function money(amount: number, currency = 'INR'): string {
  const n = Math.round(amount).toLocaleString('en-IN')
  return currency === 'INR' ? `₹${n}` : `${currency} ${n}`
}
