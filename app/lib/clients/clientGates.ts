import { createServiceClient } from '@/utils/supabase/service'

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

export interface ClientGates {
  bookingActivation: boolean
  holdActivation: boolean
  domTicketing: boolean
  intlTicketing: boolean
  policyControlling: boolean
  personalBookingsAllowed: boolean
  // Which payer types may reach a booking for this client. The per-client filter
  // over the payer dimension noted when forms of payment were built.
  allowedPayers: Set<'agency' | 'corporate' | 'traveller'>
}

const PERMISSIVE: ClientGates = {
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
}

export const CLIENT_GATE_COLUMNS =
  'booking_activation, hold_activation, dom_ticketing, intl_ticketing, ' +
  'policy_controlling, personal_bookings_allowed, ' +
  'agency_fop_allowed, corporate_fop_allowed, traveller_fop_allowed'

// Declared rather than inferred. Supabase derives a row type from a select
// STRING LITERAL; the constant above is a concatenation, so inference gives up
// and hands back an error type. Stating the shape is more honest anyway — these
// columns are read by four call sites and the compiler should know them.
interface ClientGateRow {
  booking_activation?: boolean | null
  hold_activation?: boolean | null
  dom_ticketing?: boolean | null
  intl_ticketing?: boolean | null
  policy_controlling?: boolean | null
  personal_bookings_allowed?: boolean | null
  agency_fop_allowed?: boolean | null
  corporate_fop_allowed?: boolean | null
  traveller_fop_allowed?: boolean | null
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

    const payers = new Set<'agency' | 'corporate' | 'traveller'>()
    if (data.agency_fop_allowed !== false) payers.add('agency')
    if (data.corporate_fop_allowed !== false) payers.add('corporate')
    if (data.traveller_fop_allowed !== false) payers.add('traveller')

    return {
      // `!== false` rather than a truthy test: a column that is missing because
      // the migration has not run yet reads as undefined, and undefined must
      // mean "allowed" here, not "blocked".
      bookingActivation: data.booking_activation !== false,
      holdActivation: data.hold_activation !== false,
      domTicketing: data.dom_ticketing !== false,
      intlTicketing: data.intl_ticketing !== false,
      policyControlling: data.policy_controlling !== false,
      personalBookingsAllowed: data.personal_bookings_allowed === true,
      allowedPayers: payers,
    }
  } catch (error) {
    console.error('[clientGates] could not read settings, allowing through', { clientId, error })
    return PERMISSIVE
  }
}
