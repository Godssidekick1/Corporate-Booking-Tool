// ── Form of payment status ───────────────────────────────────────────────────
// Derived, never stored — the same call as deal codes, and for the same reason:
// an `active` flag alone lets a card that expired eight months ago read as
// usable.
//
// The lifecycle here is the CARD'S OWN EXPIRY, not a validity window. A fare
// agreement has a sales period and a travel period; a card has an expiry date.
// Giving forms of payment their own date windows as well would be a second
// lifecycle nobody asked for, and two of them can disagree.
//
// Cash has no expiry, so it is only ever active or inactive.
// ─────────────────────────────────────────────────────────────────────────────

export type FopStatus = 'inactive' | 'active' | 'expiring' | 'expired'

export const FOP_STATUS_LABELS: Record<FopStatus, string> = {
  inactive: 'Inactive',
  active:   'Active',
  expiring: 'Expiring soon',
  expired:  'Expired',
}

export interface FopLifecycle {
  active: boolean
  fop_type?: string
  expiry_month?: number | null
  expiry_year?: number | null
}

// A card is valid through the END of its expiry month — 09/27 works until
// 30 September 2027, not the 1st. Getting this wrong retires every card a month
// early, which is the sort of bug that only shows up as "the card stopped
// working" with no obvious cause.
function endOfExpiryMonth(month: number, year: number): { year: number; month: number } {
  return { year, month }
}

// Warn this far ahead, so somebody can get a replacement card lodged before
// tickets start failing at the airline rather than after.
const EXPIRING_MONTHS = 2

export function fopStatus(fop: FopLifecycle, now: Date = new Date()): FopStatus {
  if (!fop.active) return 'inactive'

  // Cash settlement never expires.
  if (fop.fop_type === 'cash') return 'active'
  if (!fop.expiry_month || !fop.expiry_year) return 'active'

  const expiry = endOfExpiryMonth(fop.expiry_month, fop.expiry_year)

  // Compared as a month ordinal rather than Date objects: this is a month/year
  // pair with no day, and building a Date from it drags the browser's timezone
  // into a decision that has nothing to do with time of day.
  const expiryOrdinal = expiry.year * 12 + expiry.month
  const nowOrdinal = now.getFullYear() * 12 + (now.getMonth() + 1)

  if (nowOrdinal > expiryOrdinal) return 'expired'
  if (expiryOrdinal - nowOrdinal <= EXPIRING_MONTHS) return 'expiring'
  return 'active'
}

// Whether this form of payment may actually be applied to a booking today.
// Distinct from status on purpose: `expiring` is amber in the UI but a perfectly
// good yes here.
export function isUsable(fop: FopLifecycle, now: Date = new Date()): boolean {
  const status = fopStatus(fop, now)
  return status === 'active' || status === 'expiring'
}

// "Amex ···· 4003 · exp 09/27". One implementation so the table, the editor and
// the booking stamp cannot describe the same card three different ways.
const CARD_NAMES: Record<string, string> = {
  AX: 'Amex',
  VI: 'Visa',
  // CA is Mastercard, not cash and not Visa. The single most common mix-up in
  // this vocabulary.
  CA: 'Mastercard',
  DC: 'Diners',
}

export function describeFop(fop: {
  fop_type: string
  card_type?: string | null
  last4?: string | null
  expiry_month?: number | null
  expiry_year?: number | null
}): string {
  if (fop.fop_type === 'cash') return 'Cash / BSP settlement'

  const brand = fop.card_type ? CARD_NAMES[fop.card_type] ?? fop.card_type : 'Card'
  const tail = fop.last4 ? ` ···· ${fop.last4}` : ''
  const expiry =
    fop.expiry_month && fop.expiry_year
      ? ` · exp ${String(fop.expiry_month).padStart(2, '0')}/${String(fop.expiry_year).slice(-2)}`
      : ''

  return `${brand}${tail}${expiry}`
}

export const CARD_TYPE_LABELS = CARD_NAMES
