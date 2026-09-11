// ── The four payment types ───────────────────────────────────────────────────
// Whose money settles the ticket, and — for the traveller — where their card is.
//
// BTA/CTA HERE MEANS THE TRAVELLER'S OWN CARD. `bta_cta` is the card already
// stored against the traveller in this system; `bta_cta_manual` is the traveller
// typing card details at the payment gateway, with nothing stored here. The
// industry normally uses those letters for a corporate lodged account — it does
// not in this product, and assuming otherwise sends money to the wrong place.
//
// Both collapse to the `traveller` payer on forms_of_payment, which only knows
// agency / corporate / traveller. The split is about where the card lives.
//
// THIS FILE HAS NO IMPORTS, deliberately. It is read by the resolver (pure), by
// clientGates (which pulls in the service-role Supabase client) and by the
// Corporate Settings screen (which runs in the browser). Putting the vocabulary
// in clientGates would drag the service client into the client bundle.
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentType = 'agency' | 'corporate' | 'bta_cta' | 'bta_cta_manual'

export const PAYMENT_TYPES: PaymentType[] = ['agency', 'corporate', 'bta_cta', 'bta_cta_manual']

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  agency: 'Agency FOP',
  corporate: 'Corporate FOP',
  bta_cta: 'BTA/CTA',
  bta_cta_manual: 'BTA/CTA manual',
}

export const PAYMENT_TYPE_EFFECTS: Record<PaymentType, string> = {
  agency: 'The TMC settles and bills the client. BSP, agency cards, agency credit.',
  corporate: 'The client’s own card or credit line settles the ticket.',
  bta_cta: 'The traveller’s own card, already stored against them here, settles the ticket.',
  bta_cta_manual: 'The traveller types their card details at the payment gateway. Nothing is stored here.',
}

export const DEFAULT_PAYMENT_PRIORITY: PaymentType[] =
  ['corporate', 'agency', 'bta_cta', 'bta_cta_manual']

// Anything unrecognised is dropped and anything missing is appended in the
// default order, so a half-written column cannot silently shorten the ladder.
export function normalisePriority(raw: readonly string[] | null | undefined): PaymentType[] {
  const seen = new Set<PaymentType>()
  const out: PaymentType[] = []
  for (const value of raw ?? []) {
    const type = value as PaymentType
    if (PAYMENT_TYPES.includes(type) && !seen.has(type)) { seen.add(type); out.push(type) }
  }
  for (const type of DEFAULT_PAYMENT_PRIORITY) if (!seen.has(type)) out.push(type)
  return out
}

// A stored form of payment's payment type. `traveller` always means bta_cta
// here: bta_cta_manual has no stored instrument by definition — that is what
// makes it manual — so no row on forms_of_payment can ever be one.
export function paymentTypeOfPayer(payer: 'agency' | 'corporate' | 'traveller'): PaymentType {
  return payer === 'traveller' ? 'bta_cta' : payer
}
