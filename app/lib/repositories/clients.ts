import { sql, empty, many, maybeOne, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Clients ──────────────────────────────────────────────────────────────────
// Owns: clients, client_groups, client_gst_registrations,
// client_mandatory_info, cost_centres, buckets, bucket_clients.
//
// A client is a corporate customer of a TMC. Everything tenant-scoped on the
// corporate side hangs off clients.id.
// ─────────────────────────────────────────────────────────────────────────────

// ═══ Corporate Settings gates ═══════════════════════════════════════════════
// The switches app/lib/clients/clientGates.ts turns into decisions. Read on
// every booking, ticket, policy evaluation and form-of-payment resolution.

export type ClientGateSettings = Pick<Row<'clients'>,
  | 'status'
  | 'booking_activation' | 'hold_activation' | 'dom_ticketing' | 'intl_ticketing'
  | 'policy_controlling' | 'personal_bookings_allowed'
  | 'agency_fop_allowed' | 'corporate_fop_allowed'
  | 'bta_cta_allowed' | 'bta_cta_manual_allowed' | 'fop_priority'
  | 'markup_active' | 'discount_active' | 'processing_fee_active'
>

export async function gateSettings(db: Queryable, clientId: string): Promise<ClientGateSettings | null> {
  return maybeOne<ClientGateSettings>(db, sql`
    select status,
           booking_activation, hold_activation, dom_ticketing, intl_ticketing,
           policy_controlling, personal_bookings_allowed,
           agency_fop_allowed, corporate_fop_allowed,
           bta_cta_allowed, bta_cta_manual_allowed, fop_priority,
           markup_active, discount_active, processing_fee_active
    from clients where id = ${clientId}`)
}

// ═══ The signed-in person's company ═════════════════════════════════════════

export type ClientSummary = Pick<Row<'clients'>,
  | 'id' | 'name' | 'settings' | 'setup_completed' | 'status'
  | 'timezone' | 'currency' | 'country' | 'booking_mode'
>

export async function summary(db: Queryable, clientId: string): Promise<ClientSummary | null> {
  return maybeOne<ClientSummary>(db, sql`
    select id, name, settings, setup_completed, status, timezone, currency, country, booking_mode
    from clients where id = ${clientId}`)
}

export interface OnboardingCounts {
  employees: number
  bookings: number
  policyGroups: number
}

// The setup checklist's inputs, in ONE round trip where there used to be three.
// Client-wide rather than personal: "has anyone at this client booked yet".
//
// Policy is counted from client_policy_groups -- where policy actually lives --
// and not from the settings.approvalModel jsonb key the dashboard once read,
// which nothing had ever written.
export async function onboardingCounts(db: Queryable, clientId: string): Promise<OnboardingCounts> {
  const row = await maybeOne<OnboardingCounts>(db, sql`
    select
      (select count(*)::int from employees where client_id = ${clientId}) as employees,
      (select count(*)::int from bookings where client_id = ${clientId}) as bookings,
      (select count(*)::int from client_policy_groups where client_id = ${clientId}) as "policyGroups"`)
  return row ?? { employees: 0, bookings: 0, policyGroups: 0 }
}

// ═══ Portfolio ══════════════════════════════════════════════════════════════

export type ClientPortfolioRow = Pick<Row<'clients'>, 'id' | 'name' | 'status' | 'created_at'>

// A TMC's clients, optionally narrowed to the ones a travel counsellor was
// granted. `accessibleIds === null` means every client of the TMC (tmc_admin);
// an empty array means none.
export async function portfolio(
  db: Queryable,
  tmcId: string,
  accessibleIds: readonly string[] | null
): Promise<ClientPortfolioRow[]> {
  if (accessibleIds !== null && accessibleIds.length === 0) return []
  return many<ClientPortfolioRow>(db, sql`
    select id, name, status, created_at from clients
    where tmc_id = ${tmcId}
    ${accessibleIds !== null ? sql`and id = any(${[...accessibleIds]})` : empty}
    order by created_at, id`)
}

// ═══ Lookups used across screens ════════════════════════════════════════════

export async function bookingMode(db: Queryable, clientId: string): Promise<Pick<Row<'clients'>, 'booking_mode'> | null> {
  return maybeOne(db, sql`select booking_mode from clients where id = ${clientId}`)
}

// Which TMC a client belongs to -- the tenancy check behind "a tmc_admin passes
// the permission check for ANY clientId, so confirm this one is theirs".
export async function tenancy(db: Queryable, clientId: string): Promise<Pick<Row<'clients'>, 'id' | 'tmc_id'> | null> {
  return maybeOne(db, sql`select id, tmc_id from clients where id = ${clientId}`)
}

export type ClientName = Pick<Row<'clients'>, 'id' | 'name'>

// A TMC's clients by name, optionally narrowed to a counsellor's grants.
export async function namesForTmc(
  db: Queryable,
  tmcId: string,
  accessibleIds: readonly string[] | null
): Promise<ClientName[]> {
  if (accessibleIds !== null && accessibleIds.length === 0) return []
  return many<ClientName>(db, sql`
    select id, name from clients
    where tmc_id = ${tmcId}
    ${accessibleIds !== null ? sql`and id = any(${[...accessibleIds]})` : empty}
    order by name, id`)
}
