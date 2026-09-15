import { createServiceClient } from '@/utils/supabase/service'
import {
  DEFAULT_PAYMENT_PRIORITY, PAYMENT_TYPES, normalisePriority,
  type PaymentType,
} from '@/app/lib/fop/paymentTypes'
import type { CommercialKind } from '@/app/lib/commercials/calcOnByKind'

type ServiceClient = ReturnType<typeof createServiceClient>

// ── Client gates ─────────────────────────────────────────────────────────────
// The Corporate Settings toggles that actually stop something happening.
//
// Kept together because they are read from four different places — the booking
// route, the ticket route, the rule engine and the form-of-payment resolver —
// and a toggle whose meaning drifts between two of those is worse than no
// toggle at all.
//
// WHAT IS NOT HERE: hold_auto_issue and sbt_ticketing. Both exist as columns and
// both are labelled reserved in the UI, because there is no auto-issue path to
// gate and nobody has stated who may ticket under self-booking. Adding them here
// would imply they do something.
//
// FAILING OPEN IS DELIBERATE. If the client row cannot be read, every gate
// returns permissive. These are commercial feature switches, not security
// boundaries — tenancy and permissions are enforced elsewhere, on every route,
// before this is ever consulted. A database blip should not stop a company
// travelling, and the same call is already made by the policy engine (an
// unresolvable policy lets the booking through as unevaluated) and by
// stampFop (an error resolves to no payment method rather than blocking).
// ─────────────────────────────────────────────────────────────────────────────

// The four payment types, their labels and the default ordering live in
// app/lib/fop/paymentTypes.ts — a module with no imports, because the Corporate
// Settings screen needs the same vocabulary and importing it from here would
// pull the service-role Supabase client into the browser bundle.

export interface ClientGates {
  // Whether the client company itself is still in service.
  //
  // clients.status has been writable since the column existed and NOTHING has
  // ever read it — it rendered as a badge on the clients list and gated nothing,
  // so a TC could mark a client inactive and watch them carry on booking. It is
  // read here because this is the one module the booking route, the ticket
  // route, the policy engine and the FOP resolver all consult, which makes it
  // the only place a single flag can stop all four.
  //
  // Deactivating is how a client is REMOVED in this product — there is no
  // delete. Their bookings are financial records and their PNRs are real, so
  // the row survives and the access stops. See DELETE /api/tmc/clients/[id].
  active: boolean
  bookingActivation: boolean
  holdActivation: boolean
  domTicketing: boolean
  intlTicketing: boolean
  policyControlling: boolean
  personalBookingsAllowed: boolean
  // Which payer types may reach a booking for this client. The per-client filter
  // over the payer dimension noted when forms of payment were built. Derived
  // from the four flags below — `traveller` is in the set when either BTA/CTA
  // form is permitted, because both are the traveller paying.
  allowedPayers: Set<'agency' | 'corporate' | 'traveller'>
  // Which of the four are permitted at all.
  allowedPaymentTypes: Set<PaymentType>
  // Preference order over all four, most preferred first — including the ones
  // that are switched off. Holding all four is what keeps this from ever
  // disagreeing with the flags: the order says what is preferred, the flags say
  // what is available, and neither is trying to express the other.
  paymentPriority: PaymentType[]
  // Which commercial rules may be applied to this client's fares.
  //
  // Two of these existed before the engine did — 20260915000000 added
  // discount_active and processing_fee_active as RECORDED ONLY, with a comment
  // saying so. They stop being inert here. markup_active joined them with the
  // commercial rules migration.
  //
  // A kind switched off resolves to no rule at all, which is deliberately
  // different from having no rule configured: the arrangement survives being
  // switched off, so turning it back on does not mean rebuilding it.
  enabledCommercialKinds: Set<CommercialKind>
}

const PERMISSIVE: ClientGates = {
  // Fails open with everything else: an unreadable row must not read as
  // "this company has been shut off". Only an explicit 'inactive' does that.
  active: true,
  bookingActivation: true,
  holdActivation: true,
  domTicketing: true,
  intlTicketing: true,
  policyControlling: true,
  // The one exception: personal bookings stay OFF when unknown. A corporate
  // travel tool offering personal trips because a query failed is a surprise,
  // not a safe default.
  personalBookingsAllowed: false,
  allowedPayers: new Set(['agency', 'corporate', 'traveller'] as const),
  allowedPaymentTypes: new Set(PAYMENT_TYPES),
  paymentPriority: DEFAULT_PAYMENT_PRIORITY,
  // THE SECOND EXCEPTION TO FAILING OPEN, alongside personal bookings above,
  // and for the same kind of reason: permissive is the surprising answer here.
  //
  // Every other gate in this file fails open because blocking travel over a
  // database blip is worse than letting it through. But these decide what a
  // corporate is CHARGED. If this read fails while the rules themselves load
  // fine — a real possibility, they are separate queries — an open default
  // applies a markup to a client who switched it off, and bills them for it.
  // Empty means we charge the airline fare and nothing more. An unexpected
  // discount is a conversation; an unexpected charge is a dispute.
  enabledCommercialKinds: new Set<CommercialKind>(),
}

export const CLIENT_GATE_COLUMNS =
  'status, ' +
  'booking_activation, hold_activation, dom_ticketing, intl_ticketing, ' +
  'policy_controlling, personal_bookings_allowed, ' +
  'agency_fop_allowed, corporate_fop_allowed, ' +
  'bta_cta_allowed, bta_cta_manual_allowed, fop_priority, ' +
  'markup_active, discount_active, processing_fee_active'

// Declared rather than inferred. Supabase derives a row type from a select
// STRING LITERAL; the constant above is a concatenation, so inference gives up
// and hands back an error type. Stating the shape is more honest anyway — these
// columns are read by four call sites and the compiler should know them.
interface ClientGateRow {
  status?: string | null
  booking_activation?: boolean | null
  hold_activation?: boolean | null
  dom_ticketing?: boolean | null
  intl_ticketing?: boolean | null
  policy_controlling?: boolean | null
  personal_bookings_allowed?: boolean | null
  agency_fop_allowed?: boolean | null
  corporate_fop_allowed?: boolean | null
  bta_cta_allowed?: boolean | null
  bta_cta_manual_allowed?: boolean | null
  fop_priority?: string[] | null
  markup_active?: boolean | null
  discount_active?: boolean | null
  processing_fee_active?: boolean | null
}

export async function loadClientGates(
  service: ServiceClient,
  clientId: string | null | undefined
): Promise<ClientGates> {
  if (!clientId) return PERMISSIVE

  try {
    const { data: raw } = await service
      .from('clients')
      .select(CLIENT_GATE_COLUMNS)
      .eq('id', clientId)
      .maybeSingle()

    const data = raw as ClientGateRow | null
    if (!data) return PERMISSIVE

    const types = new Set<PaymentType>()
    if (data.agency_fop_allowed !== false) types.add('agency')
    if (data.corporate_fop_allowed !== false) types.add('corporate')
    if (data.bta_cta_allowed !== false) types.add('bta_cta')
    // The one payment type that is off unless switched on. Sending a traveller
    // to a payment gateway that does not exist yet should never be a default.
    if (data.bta_cta_manual_allowed === true) types.add('bta_cta_manual')

    const payers = new Set<'agency' | 'corporate' | 'traveller'>()
    if (types.has('agency')) payers.add('agency')
    if (types.has('corporate')) payers.add('corporate')
    if (types.has('bta_cta') || types.has('bta_cta_manual')) payers.add('traveller')

    // All three default TRUE and all three therefore read the same way. They
    // did not always: discount_active and processing_fee_active were added
    // recorded-only by 20260915000000 with `default false`, which made every
    // assigned discount and fee a silent no-op until somebody also found the
    // Controls tab. 20260919000000 flipped both defaults and backfilled.
    //
    // The switch is an opt-OUT. A rule reaches a client only because a TC
    // assigned it there, so nothing is billed that nobody configured — `!== false`
    // here cannot charge a client who has no rule.
    const commercialKinds = new Set<CommercialKind>()
    if (data.markup_active !== false) commercialKinds.add('markup')
    if (data.discount_active !== false) commercialKinds.add('discount')
    if (data.processing_fee_active !== false) commercialKinds.add('processing_fee')

    // An inactive client is off entirely, and that OVERRIDES the individual
    // switches rather than sitting beside them. Deactivation is this product's
    // delete, so it has to behave like one: leaving booking_activation true on a
    // removed client would let their people keep spending money, and a TC who
    // clicked Deactivate has every right to read that as "they are done".
    //
    // Only an explicit 'inactive' closes the gates. An unexpected status value
    // falls through as active, for the same reason the whole module fails open.
    const active = data.status !== 'inactive'

    return {
      active,
      // `!== false` rather than a truthy test: a column that is missing because
      // the migration has not run yet reads as undefined, and undefined must
      // mean "allowed" here, not "blocked".
      bookingActivation: active && data.booking_activation !== false,
      holdActivation: active && data.hold_activation !== false,
      domTicketing: active && data.dom_ticketing !== false,
      intlTicketing: active && data.intl_ticketing !== false,
      policyControlling: data.policy_controlling !== false,
      personalBookingsAllowed: data.personal_bookings_allowed === true,
      allowedPayers: payers,
      allowedPaymentTypes: types,
      paymentPriority: normalisePriority(data.fop_priority),
      enabledCommercialKinds: commercialKinds,
    }
  } catch (error) {
    console.error('[clientGates] could not read settings, allowing through', { clientId, error })
    return PERMISSIVE
  }
}
