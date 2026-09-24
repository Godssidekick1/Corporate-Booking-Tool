import { sql, empty, many, maybeOne, one, exec, type Queryable, type Sql } from '@/app/lib/db/sql'
import { searchAcross, page, nest, without, assignments, insertColumns } from '@/app/lib/db/fragments'
import type { Row } from '@/app/lib/db/types.generated'
import type { PageParams } from '@/app/lib/pagination'

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

// Which of these ids are clients of this TMC -- the check behind "every client
// you are granting access to must be yours". A caller compares lengths.
export async function idsInTmc(db: Queryable, tmcId: string, clientIds: readonly string[]): Promise<string[]> {
  if (clientIds.length === 0) return []
  const rows = await many<{ id: string }>(db, sql`
    select id from clients where tmc_id = ${tmcId} and id = any(${[...clientIds]}) order by id`)
  return rows.map(r => r.id)
}

export async function clientName(db: Queryable, clientId: string): Promise<Pick<Row<'clients'>, 'name'> | null> {
  return maybeOne(db, sql`select name from clients where id = ${clientId}`)
}

// ═══ cost_centres ═══════════════════════════════════════════════════════════

export type CostCentre = Pick<Row<'cost_centres'>, 'id' | 'code' | 'name'>

export async function costCentres(db: Queryable, clientId: string): Promise<CostCentre[]> {
  return many<CostCentre>(db, sql`
    select id, code, name from cost_centres where client_id = ${clientId} order by code, id`)
}

// Exact match: the one-person typo this guards against differs by a character.
export async function hasCostCentre(db: Queryable, clientId: string, code: string): Promise<boolean> {
  const row = await maybeOne<{ ok: boolean }>(db, sql`
    select true as ok from cost_centres where client_id = ${clientId} and code = ${code} limit 1`)
  return row !== null
}

// By id, only if it is this client's -- another client's centre satisfies the
// foreign key and would file invoices under someone else's accounting code.
export async function costCentreBelongs(db: Queryable, costCentreId: string, clientId: string): Promise<boolean> {
  const row = await maybeOne<{ ok: boolean }>(db, sql`
    select true as ok from cost_centres where id = ${costCentreId} and client_id = ${clientId}`)
  return row !== null
}

export type CostCentreRow = CostCentre & Pick<Row<'cost_centres'>, 'created_at'>

export async function costCentresWithDates(db: Queryable, clientId: string): Promise<CostCentreRow[]> {
  return many<CostCentreRow>(db, sql`
    select id, code, name, created_at from cost_centres where client_id = ${clientId} order by code, id`)
}

export async function insertCostCentre(
  db: Queryable,
  c: Pick<Row<'cost_centres'>, 'client_id' | 'code' | 'name'>
): Promise<CostCentreRow> {
  return one<CostCentreRow>(db, sql`
    insert into cost_centres (client_id, code, name) values (${c.client_id}, ${c.code}, ${c.name})
    returning id, code, name, created_at`)
}

// Returns how many rows matched: 0 when previousCode does not exist.
export async function renameCostCentre(
  db: Queryable,
  clientId: string,
  previousCode: string,
  next: Pick<Row<'cost_centres'>, 'code' | 'name'>
): Promise<number> {
  return exec(db, sql`
    update cost_centres set code = ${next.code}, name = ${next.name}
    where client_id = ${clientId} and code = ${previousCode}`)
}

export async function deleteCostCentre(db: Queryable, clientId: string, code: string): Promise<void> {
  await exec(db, sql`delete from cost_centres where client_id = ${clientId} and code = ${code}`)
}

// ═══ The client list ════════════════════════════════════════════════════════
// Serves the clients table and every client picker. The group and branch come
// back nested -- { client_groups: {…} | null, branches: {…} | null } -- the
// shape the screens were built against.

export type ClientListRow = Pick<Row<'clients'>,
  | 'id' | 'name' | 'status' | 'setup_completed' | 'created_at' | 'booking_mode' | 'client_group_id'
  | 'client_code' | 'city' | 'country' | 'email' | 'primary_contact_phone' | 'branch_id'
> & {
  client_groups: Pick<Row<'client_groups'>, 'id' | 'name' | 'city' | 'group_code'> | null
  branches: Pick<Row<'branches'>, 'id' | 'name' | 'branch_no'> | null
}

export type ClientListScope =
  | { ids: readonly string[] }
  | { search: string; page: Pick<PageParams, 'from' | 'to'>; includeInactive: boolean }

// `accessibleIds` narrows to a counsellor's grants; null means every client of
// the TMC (a tmc_admin).
export async function listForTmc(
  db: Queryable,
  tmcId: string,
  accessibleIds: readonly string[] | null,
  scope: ClientListScope
): Promise<{ rows: ClientListRow[]; total: number }> {
  if (accessibleIds !== null && accessibleIds.length === 0) return { rows: [], total: 0 }
  if ('ids' in scope && scope.ids.length === 0) return { rows: [], total: 0 }

  const narrowed = accessibleIds !== null ? sql`and c.id = any(${[...accessibleIds]})` : empty
  // Resolving specific ids is NOT filtered by status: a deactivated client can
  // still be named on an old booking, and a picker must be able to label it.
  const filter = 'ids' in scope
    ? sql`c.tmc_id = ${tmcId} ${narrowed} and c.id = any(${[...scope.ids]})`
    : sql`c.tmc_id = ${tmcId} ${narrowed}
          ${scope.includeInactive ? empty : sql`and c.status <> 'inactive'`}
          ${searchAcross([sql`c.name`, sql`c.client_code`, sql`c.city`], scope.search)}`
  const limit = 'ids' in scope ? empty : page(scope.page)

  const [rows, count] = await Promise.all([
    many<Record<string, unknown>>(db, sql`
      select c.id, c.name, c.status, c.setup_completed, c.created_at, c.booking_mode, c.client_group_id,
             c.client_code, c.city, c.country, c.email, c.primary_contact_phone, c.branch_id,
             g.id as g__id, g.name as g__name, g.city as g__city, g.group_code as g__group_code,
             b.id as b__id, b.name as b__name, b.branch_no as b__branch_no
      from clients c
      left join client_groups g on g.id = c.client_group_id
      left join branches b on b.id = c.branch_id
      where ${filter}
      order by c.created_at desc, c.id
      ${limit}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from clients c where ${filter}`),
  ])

  return {
    rows: rows.map(r => ({
      ...(without(r, 'g__', 'b__') as Omit<ClientListRow, 'client_groups' | 'branches'>),
      client_groups: nest(r, 'g__'),
      branches: nest(r, 'b__'),
    })),
    total: count.n,
  }
}

// ═══ Corporate Settings: the whole client record ════════════════════════════
// ONE column list for read and write, so GET and PATCH cannot disagree about
// what a client is -- they once did, and `size` was silently wiped on save.

export type ClientSettings = Pick<Row<'clients'>,
  | 'id' | 'name' | 'status' | 'setup_completed' | 'timezone' | 'currency' | 'country' | 'booking_mode'
  | 'created_at' | 'client_group_id' | 'managed_by' | 'branch_id' | 'registered_address' | 'industry'
  | 'primary_contact_phone' | 'size' | 'client_code' | 'sap_customer_code' | 'sap_group_code' | 'email'
  | 'phone' | 'address_1' | 'address_2' | 'city' | 'state' | 'pincode' | 'collections_name'
  | 'collections_email' | 'collections_mobile' | 'booking_activation' | 'hold_activation' | 'dom_ticketing'
  | 'intl_ticketing' | 'hold_auto_issue' | 'sbt_ticketing' | 'policy_controlling'
  | 'personal_bookings_allowed' | 'agency_fop_allowed' | 'corporate_fop_allowed' | 'bta_cta_allowed'
  | 'bta_cta_manual_allowed' | 'fop_priority' | 'markup_active' | 'discount_active'
  | 'processing_fee_active' | 'air_approval_mode' | 'hotel_approval_mode'
>

const SETTINGS = sql`
  id, name, status, setup_completed, timezone, currency, country, booking_mode, created_at,
  client_group_id, managed_by, branch_id, registered_address, industry, primary_contact_phone, size,
  client_code, sap_customer_code, sap_group_code, email, phone, address_1, address_2, city, state,
  pincode, collections_name, collections_email, collections_mobile, booking_activation,
  hold_activation, dom_ticketing, intl_ticketing, hold_auto_issue, sbt_ticketing, policy_controlling,
  personal_bookings_allowed, agency_fop_allowed, corporate_fop_allowed, bta_cta_allowed,
  bta_cta_manual_allowed, fop_priority, markup_active, discount_active, processing_fee_active,
  air_approval_mode, hotel_approval_mode`

// Everything on the record except its identity, its TMC, its creation time and
// setup_completed (derived onboarding progress, not a setting).
export type ClientSettingsEdit = Partial<Omit<ClientSettings, 'id' | 'created_at' | 'setup_completed'>>

type EditableSetting = keyof ClientSettingsEdit

const SETTINGS_EDITABLE: Record<EditableSetting, Sql> = {
  name: sql`name`, status: sql`status`, timezone: sql`timezone`, currency: sql`currency`,
  country: sql`country`, booking_mode: sql`booking_mode`, client_group_id: sql`client_group_id`,
  managed_by: sql`managed_by`, branch_id: sql`branch_id`, registered_address: sql`registered_address`,
  industry: sql`industry`, primary_contact_phone: sql`primary_contact_phone`, size: sql`size`,
  client_code: sql`client_code`, sap_customer_code: sql`sap_customer_code`,
  sap_group_code: sql`sap_group_code`, email: sql`email`, phone: sql`phone`,
  address_1: sql`address_1`, address_2: sql`address_2`, city: sql`city`, state: sql`state`,
  pincode: sql`pincode`, collections_name: sql`collections_name`,
  collections_email: sql`collections_email`, collections_mobile: sql`collections_mobile`,
  booking_activation: sql`booking_activation`, hold_activation: sql`hold_activation`,
  dom_ticketing: sql`dom_ticketing`, intl_ticketing: sql`intl_ticketing`,
  hold_auto_issue: sql`hold_auto_issue`, sbt_ticketing: sql`sbt_ticketing`,
  policy_controlling: sql`policy_controlling`, personal_bookings_allowed: sql`personal_bookings_allowed`,
  agency_fop_allowed: sql`agency_fop_allowed`, corporate_fop_allowed: sql`corporate_fop_allowed`,
  bta_cta_allowed: sql`bta_cta_allowed`, bta_cta_manual_allowed: sql`bta_cta_manual_allowed`,
  fop_priority: sql`fop_priority`, markup_active: sql`markup_active`,
  discount_active: sql`discount_active`, processing_fee_active: sql`processing_fee_active`,
  air_approval_mode: sql`air_approval_mode`, hotel_approval_mode: sql`hotel_approval_mode`,
}

export async function settings(db: Queryable, clientId: string, tmcId: string): Promise<ClientSettings | null> {
  return maybeOne<ClientSettings>(db, sql`
    select ${SETTINGS} from clients where id = ${clientId} and tmc_id = ${tmcId}`)
}

// Scoped by TMC in the write itself, not only by an earlier existence check --
// the two are separate statements. Null when the client is not this TMC's.
export async function updateSettings(
  db: Queryable,
  clientId: string,
  tmcId: string,
  patch: ClientSettingsEdit
): Promise<ClientSettings | null> {
  return maybeOne<ClientSettings>(db, sql`
    update clients set ${assignments(SETTINGS_EDITABLE, patch)}
    where id = ${clientId} and tmc_id = ${tmcId}
    returning ${SETTINGS}`)
}

export type ClientStatusRow = Pick<Row<'clients'>, 'id' | 'name' | 'status'>

export async function statusInTmc(db: Queryable, clientId: string, tmcId: string): Promise<ClientStatusRow | null> {
  return maybeOne<ClientStatusRow>(db, sql`
    select id, name, status from clients where id = ${clientId} and tmc_id = ${tmcId}`)
}

export async function setStatus(
  db: Queryable,
  clientId: string,
  tmcId: string,
  status: string
): Promise<ClientStatusRow | null> {
  return maybeOne<ClientStatusRow>(db, sql`
    update clients set status = ${status}
    where id = ${clientId} and tmc_id = ${tmcId}
    returning id, name, status`)
}

// What decides which masters reach a client: its group and bucket membership
// (read separately), and its commercial switches.
export type ReachProfile = Pick<Row<'clients'>,
  'id' | 'client_group_id' | 'markup_active' | 'discount_active' | 'processing_fee_active'>

export async function reachProfile(db: Queryable, clientId: string, tmcId: string): Promise<ReachProfile | null> {
  return maybeOne<ReachProfile>(db, sql`
    select id, client_group_id, markup_active, discount_active, processing_fee_active
    from clients where id = ${clientId} and tmc_id = ${tmcId}`)
}

export type ClientStatusName = Pick<Row<'clients'>, 'id' | 'name' | 'status'>

export async function clientsByIds(db: Queryable, clientIds: readonly string[]): Promise<ClientStatusName[]> {
  if (clientIds.length === 0) return []
  return many<ClientStatusName>(db, sql`
    select id, name, status from clients where id = any(${[...clientIds]}) order by name, id`)
}

// ═══ client_groups ══════════════════════════════════════════════════════════
// The client's own org structure (Acme Group above Acme India). Not a bucket.

export type ClientGroup = Pick<Row<'client_groups'>,
  | 'id' | 'name' | 'group_code' | 'city' | 'country' | 'contact_first_name' | 'contact_last_name'
  | 'contact_email' | 'contact_mobile' | 'bill_to_address_1' | 'bill_to_address_2' | 'bill_to_state'
  | 'bill_to_pincode' | 'created_at'
>

const GROUP = sql`
  id, name, group_code, city, country, contact_first_name, contact_last_name, contact_email,
  contact_mobile, bill_to_address_1, bill_to_address_2, bill_to_state, bill_to_pincode, created_at`

export type ClientGroupFields = Partial<Omit<ClientGroup, 'id' | 'created_at'>>

const GROUP_WRITABLE: Record<keyof ClientGroupFields, Sql> = {
  name: sql`name`, group_code: sql`group_code`, city: sql`city`, country: sql`country`,
  contact_first_name: sql`contact_first_name`, contact_last_name: sql`contact_last_name`,
  contact_email: sql`contact_email`, contact_mobile: sql`contact_mobile`,
  bill_to_address_1: sql`bill_to_address_1`, bill_to_address_2: sql`bill_to_address_2`,
  bill_to_state: sql`bill_to_state`, bill_to_pincode: sql`bill_to_pincode`,
}

export type SimpleScope =
  | { ids: readonly string[] }
  | { search: string; page: Pick<PageParams, 'from' | 'to'> }

export async function groupsForTmc(
  db: Queryable,
  tmcId: string,
  scope: SimpleScope
): Promise<{ rows: ClientGroup[]; total: number }> {
  if ('ids' in scope && scope.ids.length === 0) return { rows: [], total: 0 }
  const filter = 'ids' in scope
    ? sql`tmc_id = ${tmcId} and id = any(${[...scope.ids]})`
    : sql`tmc_id = ${tmcId} ${searchAcross([sql`name`, sql`group_code`, sql`city`], scope.search)}`
  const limit = 'ids' in scope ? empty : page(scope.page)

  const [rows, count] = await Promise.all([
    many<ClientGroup>(db, sql`select ${GROUP} from client_groups where ${filter} order by name, id ${limit}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from client_groups where ${filter}`),
  ])
  return { rows, total: count.n }
}

export async function groupInTmc(db: Queryable, groupId: string, tmcId: string): Promise<Pick<Row<'client_groups'>, 'id'> | null> {
  return maybeOne(db, sql`select id from client_groups where id = ${groupId} and tmc_id = ${tmcId}`)
}

export async function insertGroup(db: Queryable, tmcId: string, fields: ClientGroupFields & { name: string }): Promise<ClientGroup> {
  return one<ClientGroup>(db, sql`
    insert into client_groups ${insertColumns({ ...GROUP_WRITABLE, tmc_id: sql`tmc_id` }, { ...fields, tmc_id: tmcId })}
    returning ${GROUP}`)
}

export async function updateGroup(db: Queryable, groupId: string, fields: ClientGroupFields): Promise<ClientGroup> {
  return one<ClientGroup>(db, sql`
    update client_groups set ${assignments(GROUP_WRITABLE, fields)} where id = ${groupId}
    returning ${GROUP}`)
}

// Clients in the group are unassigned by the foreign key (ON DELETE SET NULL),
// not deleted.
export async function deleteGroup(db: Queryable, groupId: string): Promise<void> {
  await exec(db, sql`delete from client_groups where id = ${groupId}`)
}

export async function groupNames(db: Queryable, groupIds: readonly string[]): Promise<Map<string, string>> {
  if (groupIds.length === 0) return new Map()
  const rows = await many<{ id: string; name: string }>(db, sql`
    select id, name from client_groups where id = any(${[...groupIds]})`)
  return new Map(rows.map(r => [r.id, r.name]))
}

// ═══ buckets and bucket_clients ═════════════════════════════════════════════
// A bucket is a curated set of clients that masters (deal codes, forms of
// payment, commercials) are assigned to.

export type Bucket = Pick<Row<'buckets'>, 'id' | 'name' | 'code' | 'description' | 'created_at'>
export type BucketRecord = Pick<Row<'buckets'>, 'id' | 'tmc_id' | 'name' | 'code' | 'description'>
export type BucketLabel = Pick<Row<'buckets'>, 'id' | 'name' | 'code'>

export async function bucketsForTmc(
  db: Queryable,
  tmcId: string,
  scope: SimpleScope
): Promise<{ rows: Bucket[]; total: number }> {
  if ('ids' in scope && scope.ids.length === 0) return { rows: [], total: 0 }
  const filter = 'ids' in scope
    ? sql`tmc_id = ${tmcId} and id = any(${[...scope.ids]})`
    : sql`tmc_id = ${tmcId} ${searchAcross([sql`name`, sql`code`], scope.search)}`
  const limit = 'ids' in scope ? empty : page(scope.page)

  const [rows, count] = await Promise.all([
    many<Bucket>(db, sql`
      select id, name, code, description, created_at from buckets where ${filter}
      order by name, id ${limit}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from buckets where ${filter}`),
  ])
  return { rows, total: count.n }
}

export async function bucketInTmc(db: Queryable, bucketId: string, tmcId: string): Promise<BucketRecord | null> {
  return maybeOne<BucketRecord>(db, sql`
    select id, tmc_id, name, code, description from buckets where id = ${bucketId} and tmc_id = ${tmcId}`)
}

export async function bucketIdsInTmc(db: Queryable, tmcId: string, bucketIds: readonly string[]): Promise<string[]> {
  if (bucketIds.length === 0) return []
  const rows = await many<{ id: string }>(db, sql`
    select id from buckets where tmc_id = ${tmcId} and id = any(${[...bucketIds]}) order by id`)
  return rows.map(r => r.id)
}

export async function insertBucket(
  db: Queryable,
  b: Pick<Row<'buckets'>, 'tmc_id' | 'name' | 'code' | 'description' | 'created_by'>
): Promise<Bucket> {
  return one<Bucket>(db, sql`
    insert into buckets (tmc_id, name, code, description, created_by)
    values (${b.tmc_id}, ${b.name}, ${b.code}, ${b.description}, ${b.created_by})
    returning id, name, code, description, created_at`)
}

export type BucketEdit = Partial<Pick<Row<'buckets'>, 'name' | 'code' | 'description'>>

export async function updateBucket(db: Queryable, bucketId: string, patch: BucketEdit): Promise<void> {
  await exec(db, sql`
    update buckets set ${assignments({ name: sql`name`, code: sql`code`, description: sql`description` }, patch)}
    where id = ${bucketId}`)
}

export async function deleteBucket(db: Queryable, bucketId: string): Promise<void> {
  await exec(db, sql`delete from buckets where id = ${bucketId}`)
}

export async function memberCounts(db: Queryable, bucketIds: readonly string[]): Promise<Map<string, number>> {
  if (bucketIds.length === 0) return new Map()
  const rows = await many<{ bucket_id: string; n: number }>(db, sql`
    select bucket_id, count(*)::int as n from bucket_clients
    where bucket_id = any(${[...bucketIds]}) group by bucket_id`)
  return new Map(rows.map(r => [r.bucket_id, r.n]))
}

export async function memberIds(db: Queryable, bucketId: string): Promise<string[]> {
  const rows = await many<{ client_id: string }>(db, sql`
    select client_id from bucket_clients where bucket_id = ${bucketId} order by client_id`)
  return rows.map(r => r.client_id)
}

// Wholesale replacement: delete-then-insert. The caller runs it in a
// transaction, or a failed insert leaves the bucket empty.
export async function replaceMembers(db: Queryable, bucketId: string, clientIds: readonly string[]): Promise<void> {
  await exec(db, sql`delete from bucket_clients where bucket_id = ${bucketId}`)
  if (clientIds.length === 0) return
  await exec(db, sql`
    insert into bucket_clients (bucket_id, client_id)
    select ${bucketId}, c from unnest(${[...clientIds]}::uuid[]) as c`)
}

export async function bucketIdsOfClient(db: Queryable, clientId: string): Promise<string[]> {
  const rows = await many<{ bucket_id: string }>(db, sql`
    select bucket_id from bucket_clients where client_id = ${clientId} order by bucket_id`)
  return rows.map(r => r.bucket_id)
}

export async function bucketsOfClient(db: Queryable, clientId: string): Promise<BucketLabel[]> {
  return many<BucketLabel>(db, sql`
    select b.id, b.name, b.code from bucket_clients bc
    join buckets b on b.id = bc.bucket_id
    where bc.client_id = ${clientId}
    order by b.name, b.id`)
}

// The same pivot from the client's side. Same caveat as replaceMembers.
export async function replaceBucketsOfClient(db: Queryable, clientId: string, bucketIds: readonly string[]): Promise<void> {
  await exec(db, sql`delete from bucket_clients where client_id = ${clientId}`)
  if (bucketIds.length === 0) return
  await exec(db, sql`
    insert into bucket_clients (bucket_id, client_id)
    select b, ${clientId} from unnest(${[...bucketIds]}::uuid[]) as b`)
}

export async function bucketLabels(db: Queryable, bucketIds: readonly string[]): Promise<Map<string, BucketLabel>> {
  if (bucketIds.length === 0) return new Map()
  const rows = await many<BucketLabel>(db, sql`
    select id, name, code from buckets where id = any(${[...bucketIds]})`)
  return new Map(rows.map(r => [r.id, r]))
}

// ═══ client_gst_registrations ═══════════════════════════════════════════════

export type GstRegistration = Pick<Row<'client_gst_registrations'>,
  | 'id' | 'client_id' | 'gstin' | 'gst_holder' | 'email' | 'contact' | 'address_1' | 'address_2'
  | 'city' | 'state' | 'country' | 'zip' | 'registration_date' | 'valid_from' | 'valid_to'
  | 'cost_centre_id' | 'is_primary' | 'created_at'
>

const GST = sql`
  id, client_id, gstin, gst_holder, email, contact, address_1, address_2, city, state, country, zip,
  registration_date, valid_from, valid_to, cost_centre_id, is_primary, created_at`

export type GstFields = Partial<Omit<GstRegistration, 'id' | 'client_id' | 'created_at'>>

const GST_WRITABLE: Record<keyof GstFields, Sql> = {
  gstin: sql`gstin`, gst_holder: sql`gst_holder`, email: sql`email`, contact: sql`contact`,
  address_1: sql`address_1`, address_2: sql`address_2`, city: sql`city`, state: sql`state`,
  country: sql`country`, zip: sql`zip`, registration_date: sql`registration_date`,
  valid_from: sql`valid_from`, valid_to: sql`valid_to`, cost_centre_id: sql`cost_centre_id`,
  is_primary: sql`is_primary`,
}

// Primary first, then the most recent validity window.
export async function gstRegistrations(db: Queryable, clientId: string): Promise<GstRegistration[]> {
  return many<GstRegistration>(db, sql`
    select ${GST} from client_gst_registrations where client_id = ${clientId}
    order by is_primary desc, valid_from desc nulls last, created_at, id`)
}

export type GstWindow = Pick<Row<'client_gst_registrations'>, 'id' | 'valid_from' | 'valid_to' | 'cost_centre_id'>

export async function gstWindow(db: Queryable, entryId: string, clientId: string): Promise<GstWindow | null> {
  return maybeOne<GstWindow>(db, sql`
    select id, valid_from, valid_to, cost_centre_id from client_gst_registrations
    where id = ${entryId} and client_id = ${clientId}`)
}

// Registrations sharing a cost centre (or sharing having none) -- the set a
// validity window must not overlap.
export async function gstSiblings(
  db: Queryable,
  clientId: string,
  costCentreId: string | null,
  excludeId: string | null
): Promise<GstWindow[]> {
  return many<GstWindow>(db, sql`
    select id, valid_from, valid_to, cost_centre_id from client_gst_registrations
    where client_id = ${clientId}
      and ${costCentreId ? sql`cost_centre_id = ${costCentreId}` : sql`cost_centre_id is null`}
      ${excludeId ? sql`and id <> ${excludeId}` : empty}
    order by id`)
}

// Only one primary per client (partial unique index). Cleared FIRST, so the
// index never sees two at once.
export async function clearOtherPrimaries(db: Queryable, clientId: string, keepId: string | null): Promise<void> {
  await exec(db, sql`
    update client_gst_registrations set is_primary = false
    where client_id = ${clientId} and is_primary
    ${keepId ? sql`and id <> ${keepId}` : empty}`)
}

export async function insertGst(db: Queryable, clientId: string, fields: GstFields): Promise<GstRegistration> {
  return one<GstRegistration>(db, sql`
    insert into client_gst_registrations
    ${insertColumns({ ...GST_WRITABLE, client_id: sql`client_id` }, { ...fields, client_id: clientId })}
    returning ${GST}`)
}

// Null when the entry is not this client's.
export async function updateGst(
  db: Queryable,
  entryId: string,
  clientId: string,
  fields: GstFields
): Promise<GstRegistration | null> {
  return maybeOne<GstRegistration>(db, sql`
    update client_gst_registrations set ${assignments(GST_WRITABLE, fields)}
    where id = ${entryId} and client_id = ${clientId}
    returning ${GST}`)
}

export async function deleteGst(db: Queryable, entryId: string, clientId: string): Promise<void> {
  await exec(db, sql`delete from client_gst_registrations where id = ${entryId} and client_id = ${clientId}`)
}

// ═══ client_mandatory_info ══════════════════════════════════════════════════

export type MandatoryEntry = Pick<Row<'client_mandatory_info'>,
  'id' | 'code' | 'description' | 'type' | 'gds_entry' | 'value_prefix' | 'is_mandatory' | 'created_at'>

const MANDATORY = sql`id, code, description, type, gds_entry, value_prefix, is_mandatory, created_at`

export async function mandatoryInfo(db: Queryable, clientId: string): Promise<MandatoryEntry[]> {
  return many<MandatoryEntry>(db, sql`
    select ${MANDATORY} from client_mandatory_info where client_id = ${clientId} order by code, id`)
}

// The code is the identity: saving the same code again edits that entry.
export async function saveMandatory(
  db: Queryable,
  m: Omit<MandatoryEntry, 'id' | 'created_at'> & { client_id: string }
): Promise<MandatoryEntry> {
  return one<MandatoryEntry>(db, sql`
    insert into client_mandatory_info (client_id, code, description, type, gds_entry, value_prefix, is_mandatory)
    values (${m.client_id}, ${m.code}, ${m.description}, ${m.type}, ${m.gds_entry}, ${m.value_prefix}, ${m.is_mandatory})
    on conflict (client_id, code) do update set
      description = excluded.description, type = excluded.type, gds_entry = excluded.gds_entry,
      value_prefix = excluded.value_prefix, is_mandatory = excluded.is_mandatory
    returning ${MANDATORY}`)
}

export async function deleteMandatory(db: Queryable, entryId: string, clientId: string): Promise<void> {
  await exec(db, sql`delete from client_mandatory_info where id = ${entryId} and client_id = ${clientId}`)
}

// ═══ Booking stamps ═════════════════════════════════════════════════════════

// What decides which masters reach a client at booking time: its TMC, group
// and branch (bucket membership is read separately). Not tenant-filtered: the
// caller already holds a client id it resolved from the signed-in traveller.
export type StampProfile = Pick<Row<'clients'>, 'id' | 'tmc_id' | 'client_group_id' | 'branch_id'>

export async function stampProfile(db: Queryable, clientId: string): Promise<StampProfile | null> {
  return maybeOne<StampProfile>(db, sql`
    select id, tmc_id, client_group_id, branch_id from clients where id = ${clientId}`)
}

// ═══ Commercial coverage ════════════════════════════════════════════════════

export type CommercialSwitches = Pick<Row<'clients'>,
  'id' | 'name' | 'client_group_id' | 'markup_active' | 'discount_active' | 'processing_fee_active'>

// A TMC's clients with their commercial switches, optionally narrowed to a
// counsellor's grants (null = every client).
export async function commercialSwitches(
  db: Queryable,
  tmcId: string,
  accessibleIds: readonly string[] | null
): Promise<CommercialSwitches[]> {
  if (accessibleIds !== null && accessibleIds.length === 0) return []
  return many<CommercialSwitches>(db, sql`
    select id, name, client_group_id, markup_active, discount_active, processing_fee_active
    from clients
    where tmc_id = ${tmcId}
    ${accessibleIds !== null ? sql`and id = any(${[...accessibleIds]})` : empty}
    order by name, id`)
}

export async function memberships(
  db: Queryable,
  clientIds: readonly string[]
): Promise<Pick<Row<'bucket_clients'>, 'bucket_id' | 'client_id'>[]> {
  if (clientIds.length === 0) return []
  return many(db, sql`
    select bucket_id, client_id from bucket_clients
    where client_id = any(${[...clientIds]})
    order by client_id, bucket_id`)
}

export async function groupNamesForTmc(db: Queryable, tmcId: string): Promise<Map<string, string>> {
  const rows = await many<{ id: string; name: string }>(db, sql`
    select id, name from client_groups where tmc_id = ${tmcId}`)
  return new Map(rows.map(r => [r.id, r.name]))
}

export async function clientNames(db: Queryable, clientIds: readonly string[]): Promise<Map<string, string>> {
  if (clientIds.length === 0) return new Map()
  const rows = await many<{ id: string; name: string }>(db, sql`
    select id, name from clients where id = any(${[...clientIds]})`)
  return new Map(rows.map(r => [r.id, r.name]))
}

// Corporate Settings: whether flights and hotels need approval at all.
export async function approvalModes(
  db: Queryable,
  clientId: string
): Promise<Pick<Row<'clients'>, 'air_approval_mode' | 'hotel_approval_mode'> | null> {
  return maybeOne(db, sql`select air_approval_mode, hotel_approval_mode from clients where id = ${clientId}`)
}

// ═══ Assignment targets ═════════════════════════════════════════════════════
// Deal codes and forms of payment are assigned to a client, a client group or
// a bucket. Those are plain FKs, so an id borrowed from another tenant would
// satisfy them -- every target is checked against the TMC first.

export type TargetKind = 'client' | 'client_group' | 'bucket'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TARGET_TABLE: Record<TargetKind, Sql> = {
  client: sql`clients`,
  client_group: sql`client_groups`,
  bucket: sql`buckets`,
}

export function targetKey(kind: TargetKind, id: string): string {
  return `${kind}:${id}`
}

// Which of these targets are this TMC's, as targetKey()s: one query per kind
// present, rather than one per target.
export async function targetIdsInTmc(
  db: Queryable,
  tmcId: string,
  targets: readonly { kind: TargetKind; id: string }[]
): Promise<Set<string>> {
  // A malformed id cannot be anyone's, and must not fail the uuid cast.
  const wellFormed = targets.filter(t => UUID.test(t.id))
  const kinds = [...new Set(wellFormed.map(t => t.kind))]
  const found = await Promise.all(kinds.map(kind => many<{ id: string }>(db, sql`
    select id from ${TARGET_TABLE[kind]}
    where tmc_id = ${tmcId} and id = any(${wellFormed.filter(t => t.kind === kind).map(t => t.id)}::uuid[])`)))
  return new Set(kinds.flatMap((kind, i) => found[i].map(r => targetKey(kind, r.id))))
}

export type CoverageClient = Pick<Row<'clients'>, 'id' | 'name' | 'client_group_id'>

// The clients a coverage screen resolves for: this TMC's, narrowed to what the
// caller may see (null = everything) and optionally to one client.
export async function coverageClients(
  db: Queryable,
  tmcId: string,
  accessibleIds: readonly string[] | null,
  onlyClientId?: string | null
): Promise<CoverageClient[]> {
  return many<CoverageClient>(db, sql`
    select id, name, client_group_id from clients
    where tmc_id = ${tmcId}
    ${accessibleIds ? sql`and id = any(${[...accessibleIds]})` : empty}
    ${onlyClientId ? sql`and id = ${onlyClientId}` : empty}
    order by name, id`)
}

// ═══ Onboarding ═════════════════════════════════════════════════════════════

export type SameNameClient = Pick<Row<'clients'>, 'id' | 'name' | 'client_code' | 'city' | 'created_at'>

// Existing clients this name would be confused with, case-insensitively. A
// warning, never a rule: nothing constrains clients.name, nor should it.
export async function sameName(db: Queryable, tmcId: string, name: string): Promise<SameNameClient[]> {
  return many<SameNameClient>(db, sql`
    select id, name, client_code, city, created_at from clients
    where tmc_id = ${tmcId} and lower(name) = lower(${name})
    order by created_at, id
    limit 5`)
}

export type NewClient = Pick<Row<'clients'>, 'tmc_id' | 'name'> & Partial<Pick<Row<'clients'>,
  | 'registered_address' | 'industry' | 'primary_contact_phone' | 'size' | 'booking_mode' | 'client_group_id'>>

// Active, not yet set up. A null tmc_id is a company that registered itself.
export async function insertClient(db: Queryable, c: NewClient): Promise<{ id: string }> {
  return one<{ id: string }>(db, sql`
    insert into clients (tmc_id, name, status, setup_completed, registered_address, industry,
                         primary_contact_phone, size, booking_mode, client_group_id)
    values (${c.tmc_id}, ${c.name}, 'active', false, ${c.registered_address ?? null}, ${c.industry ?? null},
            ${c.primary_contact_phone ?? null}, ${c.size ?? null}, ${c.booking_mode ?? 'sbt'}, ${c.client_group_id ?? null})
    returning id`)
}
