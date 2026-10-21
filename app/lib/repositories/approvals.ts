import { sql, empty, json, join, many, maybeOne, one, exec, type Queryable, type Sql } from '@/app/lib/db/sql'
import { assignments, page } from '@/app/lib/db/fragments'
import type { PageParams } from '@/app/lib/pagination'
import type { Row } from '@/app/lib/db/types.generated'
import type { TemplateTier } from '@/app/lib/approval-engine/linkedApprovalTemplates'

// ── Approvals ────────────────────────────────────────────────────────────────
// Owns: approvals, approval_chain_templates, approval_tier_approvers,
// employee_approval_templates, band_approval_templates,
// client_default_approval_templates.
//
// A chain TEMPLATE holds structure only (steps, verdict thresholds). Who fills
// each step is bound per client in approval_tier_approvers, because a template
// can be shared across clients and a person exists in just one of them. Which
// template applies to someone is a three-rung ladder: employee -> band ->
// client default. All of that is decided in app/lib/approval-engine; this
// module reads and writes the pieces.
// ─────────────────────────────────────────────────────────────────────────────

// ═══ Templates ══════════════════════════════════════════════════════════════

// tiers is jsonb holding TemplateTier[]; returned as that type.
export type TemplateRow = Omit<Pick<Row<'approval_chain_templates'>,
  'id' | 'name' | 'code' | 'mode' | 'quorum' | 'tiers'>, 'tiers'> & { tiers: TemplateTier[] | null }

export async function template(db: Queryable, templateId: string): Promise<TemplateRow | null> {
  return maybeOne<TemplateRow>(db, sql`
    select id, name, code, mode, quorum, tiers from approval_chain_templates where id = ${templateId}`)
}

export type TemplateOwnership = Pick<Row<'approval_chain_templates'>, 'id' | 'tmc_id' | 'client_id' | 'name'>

export async function ownership(db: Queryable, templateId: string): Promise<TemplateOwnership | null> {
  return maybeOne<TemplateOwnership>(db, sql`
    select id, tmc_id, client_id, name from approval_chain_templates where id = ${templateId}`)
}

export type TemplateListRow = Omit<Pick<Row<'approval_chain_templates'>,
  'id' | 'name' | 'code' | 'description' | 'mode' | 'quorum' | 'tiers' | 'version' | 'created_at' | 'client_id'>,
  'tiers'> & { tiers: TemplateTier[] | null }

const TEMPLATE_LIST = sql`id, name, code, description, mode, quorum, tiers, version, created_at, client_id`

// Search is a plain substring on name or code, as it always was.
export async function templatesForTmc(db: Queryable, tmcId: string, search?: string | null): Promise<TemplateListRow[]> {
  const term = search?.trim()
  return many<TemplateListRow>(db, sql`
    select ${TEMPLATE_LIST} from approval_chain_templates
    where tmc_id = ${tmcId}
    ${term ? sql`and (name ilike ${`%${term}%`} or code ilike ${`%${term}%`})` : empty}
    order by name, id`)
}

export interface NewTemplate {
  tmc_id: string
  client_id: string | null
  name: string
  code: string | null
  description: string | null
  mode: string
  quorum: string
  tiers: TemplateTier[]
  updated_by: string | null
}

export async function insertTemplate(db: Queryable, t: NewTemplate): Promise<TemplateListRow> {
  return one<TemplateListRow>(db, sql`
    insert into approval_chain_templates (tmc_id, client_id, name, code, description, mode, quorum, tiers, updated_by)
    values (${t.tmc_id}, ${t.client_id}, ${t.name}, ${t.code}, ${t.description}, ${t.mode}, ${t.quorum},
            ${json(t.tiers)}, ${t.updated_by})
    returning ${TEMPLATE_LIST}`)
}

export type TemplateEdit = Partial<{
  name: string
  code: string | null
  description: string | null
  mode: string
  quorum: string
  tiers: TemplateTier[]
  version: number
  updated_by: string | null
}>

const TEMPLATE_EDITABLE: Record<keyof TemplateEdit, Sql> = {
  name: sql`name`, code: sql`code`, description: sql`description`, mode: sql`mode`,
  quorum: sql`quorum`, tiers: sql`tiers`, version: sql`version`, updated_by: sql`updated_by`,
}

export async function updateTemplate(db: Queryable, templateId: string, patch: TemplateEdit): Promise<TemplateListRow> {
  const values = { ...patch, tiers: patch.tiers === undefined ? undefined : json(patch.tiers) }
  return one<TemplateListRow>(db, sql`
    update approval_chain_templates set ${assignments(TEMPLATE_EDITABLE, values)}
    where id = ${templateId}
    returning ${TEMPLATE_LIST}`)
}

export async function deleteTemplate(db: Queryable, templateId: string): Promise<void> {
  await exec(db, sql`delete from approval_chain_templates where id = ${templateId}`)
}

export type TemplateRecord = Omit<Pick<Row<'approval_chain_templates'>,
  'id' | 'tmc_id' | 'name' | 'mode' | 'quorum' | 'tiers' | 'version'>, 'tiers'> & { tiers: TemplateTier[] | null }

export async function templateRecord(db: Queryable, templateId: string): Promise<TemplateRecord | null> {
  return maybeOne<TemplateRecord>(db, sql`
    select id, tmc_id, name, mode, quorum, tiers, version from approval_chain_templates where id = ${templateId}`)
}

// ═══ How far a template reaches ═════════════════════════════════════════════

async function countsBy(db: Queryable, table: Sql, templateIds: readonly string[]): Promise<Map<string, number>> {
  if (templateIds.length === 0) return new Map()
  const rows = await many<{ template_id: string; n: number }>(db, sql`
    select template_id, count(*)::int as n from ${table}
    where template_id = any(${[...templateIds]}) group by template_id`)
  return new Map(rows.map(r => [r.template_id, r.n]))
}

export async function employeeCounts(db: Queryable, templateIds: readonly string[]): Promise<Map<string, number>> {
  return countsBy(db, sql`employee_approval_templates`, templateIds)
}

export async function defaultCounts(db: Queryable, templateIds: readonly string[]): Promise<Map<string, number>> {
  return countsBy(db, sql`client_default_approval_templates`, templateIds)
}

export async function bandCounts(db: Queryable, templateIds: readonly string[]): Promise<Map<string, number>> {
  return countsBy(db, sql`band_approval_templates`, templateIds)
}

// ═══ Who fills each step, per client ════════════════════════════════════════

export type Binding = Pick<Row<'approval_tier_approvers'>, 'tier' | 'approver_type' | 'approver_user_id' | 'min_band_rank'>

export async function bindings(db: Queryable, clientId: string, templateId: string): Promise<Binding[]> {
  return many<Binding>(db, sql`
    select tier, approver_type, approver_user_id, min_band_rank from approval_tier_approvers
    where client_id = ${clientId} and template_id = ${templateId}
    order by tier`)
}

export interface NewBinding extends Binding {
  assigned_by: string | null
}

// The approval_tier_approvers_client_check trigger rejects a specific_user who
// works elsewhere (a check violation) -- callers map that to a 400.
export async function bind(db: Queryable, clientId: string, templateId: string, b: NewBinding): Promise<void> {
  await exec(db, sql`
    insert into approval_tier_approvers (client_id, template_id, tier, approver_type, approver_user_id, min_band_rank, assigned_by, assigned_at)
    values (${clientId}, ${templateId}, ${b.tier}, ${b.approver_type}, ${b.approver_user_id}, ${b.min_band_rank}, ${b.assigned_by}, now())
    on conflict (client_id, template_id, tier) do update set
      approver_type = excluded.approver_type, approver_user_id = excluded.approver_user_id,
      min_band_rank = excluded.min_band_rank, assigned_by = excluded.assigned_by, assigned_at = now()`)
}

export async function unbind(db: Queryable, clientId: string, templateId: string, tier: number): Promise<void> {
  await exec(db, sql`
    delete from approval_tier_approvers where client_id = ${clientId} and template_id = ${templateId} and tier = ${tier}`)
}

// Wholesale: step numbering shifts whenever a step is removed, so matching old
// rows to new positions would be guesswork. The caller runs this in a
// transaction -- a failed insert must not leave the chain with no approvers.
export async function replaceBindings(
  db: Queryable,
  clientId: string,
  templateId: string,
  rows: readonly NewBinding[]
): Promise<void> {
  await exec(db, sql`delete from approval_tier_approvers where client_id = ${clientId} and template_id = ${templateId}`)
  if (rows.length === 0) return
  await exec(db, sql`
    insert into approval_tier_approvers (client_id, template_id, tier, approver_type, approver_user_id, min_band_rank, assigned_by)
    values ${join(rows.map(r => sql`(
      ${clientId}, ${templateId}, ${r.tier}, ${r.approver_type}, ${r.approver_user_id}, ${r.min_band_rank}, ${r.assigned_by})`))}`)
}

// ═══ The assignment ladder: employee -> band -> client default ═══════════════

export async function employeeTemplateId(db: Queryable, employeeId: string, category: string): Promise<string | null> {
  return (await maybeOne<{ template_id: string }>(db, sql`
    select template_id from employee_approval_templates
    where employee_id = ${employeeId} and category = ${category}`))?.template_id ?? null
}

export async function bandTemplateId(
  db: Queryable,
  clientId: string,
  bandCode: string,
  category: string
): Promise<string | null> {
  return (await maybeOne<{ template_id: string }>(db, sql`
    select template_id from band_approval_templates
    where client_id = ${clientId} and band_code = ${bandCode} and category = ${category}`))?.template_id ?? null
}

export async function defaultTemplateId(db: Queryable, clientId: string, category: string): Promise<string | null> {
  return (await maybeOne<{ template_id: string }>(db, sql`
    select template_id from client_default_approval_templates
    where client_id = ${clientId} and category = ${category}`))?.template_id ?? null
}

export type EmployeeAssignment = Pick<Row<'employee_approval_templates'>, 'employee_id' | 'category' | 'template_id'>
export type BandAssignment = Pick<Row<'band_approval_templates'>, 'band_code' | 'category' | 'template_id'>
export type DefaultAssignment = Pick<Row<'client_default_approval_templates'>, 'category' | 'template_id'>

export async function employeeAssignments(db: Queryable, employeeIds: readonly string[]): Promise<EmployeeAssignment[]> {
  if (employeeIds.length === 0) return []
  return many<EmployeeAssignment>(db, sql`
    select employee_id, category, template_id from employee_approval_templates
    where employee_id = any(${[...employeeIds]})
    order by employee_id, category`)
}

export async function bandAssignments(db: Queryable, clientId: string): Promise<BandAssignment[]> {
  return many<BandAssignment>(db, sql`
    select band_code, category, template_id from band_approval_templates
    where client_id = ${clientId} order by band_code, category`)
}

export async function defaultAssignments(db: Queryable, clientId: string): Promise<DefaultAssignment[]> {
  return many<DefaultAssignment>(db, sql`
    select category, template_id from client_default_approval_templates
    where client_id = ${clientId} order by category`)
}

export async function assignToEmployees(
  db: Queryable,
  employeeIds: readonly string[],
  category: string,
  templateId: string,
  assignedBy: string | null
): Promise<void> {
  if (employeeIds.length === 0) return
  await exec(db, sql`
    insert into employee_approval_templates (employee_id, category, template_id, assigned_by, assigned_at)
    select e, ${category}, ${templateId}, ${assignedBy}, now() from unnest(${[...employeeIds]}::uuid[]) as e
    on conflict (employee_id, category) do update set
      template_id = excluded.template_id, assigned_by = excluded.assigned_by, assigned_at = now()`)
}

export async function clearEmployees(db: Queryable, employeeIds: readonly string[], category: string): Promise<void> {
  if (employeeIds.length === 0) return
  await exec(db, sql`
    delete from employee_approval_templates where category = ${category} and employee_id = any(${[...employeeIds]})`)
}

export async function assignToBand(
  db: Queryable,
  clientId: string,
  bandCode: string,
  category: string,
  templateId: string,
  assignedBy: string | null
): Promise<void> {
  await exec(db, sql`
    insert into band_approval_templates (client_id, band_code, category, template_id, assigned_by, assigned_at)
    values (${clientId}, ${bandCode}, ${category}, ${templateId}, ${assignedBy}, now())
    on conflict (client_id, band_code, category) do update set
      template_id = excluded.template_id, assigned_by = excluded.assigned_by, assigned_at = now()`)
}

export async function clearBand(db: Queryable, clientId: string, bandCode: string, category: string): Promise<void> {
  await exec(db, sql`
    delete from band_approval_templates where client_id = ${clientId} and band_code = ${bandCode} and category = ${category}`)
}

export async function assignDefault(
  db: Queryable,
  clientId: string,
  category: string,
  templateId: string,
  assignedBy: string | null
): Promise<void> {
  await exec(db, sql`
    insert into client_default_approval_templates (client_id, category, template_id, assigned_by, assigned_at)
    values (${clientId}, ${category}, ${templateId}, ${assignedBy}, now())
    on conflict (client_id, category) do update set
      template_id = excluded.template_id, assigned_by = excluded.assigned_by, assigned_at = now()`)
}

export async function clearDefault(db: Queryable, clientId: string, category: string): Promise<void> {
  await exec(db, sql`
    delete from client_default_approval_templates where client_id = ${clientId} and category = ${category}`)
}

// ═══ Approval rows ══════════════════════════════════════════════════════════

// What an approval row approves: one booking (air approval, at booking time)
// or one trip (the trip's sign-off, once it is ready). Exactly one -- the
// table's approvals_one_subject_check.
export type Subject = { booking: string } | { trip: string }

const subjectIs = (s: Subject): Sql =>
  'booking' in s ? sql`booking_id = ${s.booking}` : sql`trip_id = ${s.trip}`

export interface NewApproval {
  client_id: string
  subject: Subject
  approver_id: string
  tier: number
  status: 'pending' | 'approved'
  reason: string
  chain_template_id: string
  verdict: string
  // Set for rows logged as already approved (self, top of hierarchy).
  actioned: boolean
  // A pending row passes to the approver's manager after this many hours
  // (the company's approval_escalation_hours). Absent or null: never.
  escalate_after_hours?: number | null
}

export async function raise(
  db: Queryable,
  rows: readonly NewApproval[]
): Promise<Pick<Row<'approvals'>, 'id' | 'approver_id'>[]> {
  if (rows.length === 0) return []
  return many(db, sql`
    insert into approvals (client_id, booking_id, trip_id, approver_id, tier, status, reason, chain_template_id, verdict, actioned_at, escalates_at)
    values ${join(rows.map(r => sql`(
      ${r.client_id}, ${'booking' in r.subject ? r.subject.booking : null}, ${'trip' in r.subject ? r.subject.trip : null}, ${r.approver_id}, ${r.tier}, ${r.status}, ${r.reason},
      ${r.chain_template_id}, ${r.verdict}, ${r.actioned ? sql`now()` : sql`null`},
      ${r.status === 'pending' && r.escalate_after_hours ? sql`now() + make_interval(hours => ${r.escalate_after_hours}::int)` : sql`null`})`))}
    returning id, approver_id`)
}

// ═══ Escalation ══════════════════════════════════════════════════════════════
// app/lib/approval-engine/escalate.ts: a step waiting past its company's limit
// passes to the approver's own manager, once.

export type DueEscalation = Pick<Row<'approvals'>,
  'id' | 'client_id' | 'booking_id' | 'trip_id' | 'approver_id' | 'tier' | 'reason' | 'verdict' | 'chain_template_id'>

export async function dueForEscalation(db: Queryable, now: Date): Promise<DueEscalation[]> {
  return many<DueEscalation>(db, sql`
    select id, client_id, booking_id, trip_id, approver_id, tier, reason, verdict, chain_template_id
    from approvals where status = 'pending' and escalates_at <= ${now.toISOString()}
    order by escalates_at, id limit 500`)
}

// Takes the row for this run: its timer cleared, so it is escalated (or kept)
// once. False when it was decided, or claimed, since it was read.
export async function claimForEscalation(db: Queryable, approvalId: string): Promise<boolean> {
  return (await exec(db, sql`
    update approvals set escalates_at = null
    where id = ${approvalId} and status = 'pending' and escalates_at is not null`)) === 1
}

// The approver's own manager: active, at the same company, and not the
// traveller (nobody approves their own booking or trip).
export async function escalationTarget(db: Queryable, row: DueEscalation): Promise<string | null> {
  const found = await maybeOne<{ id: string }>(db, sql`
    select m.id from employees a join employees m on m.id = a.manager_id
    where a.id = ${row.approver_id} and m.id <> a.id and m.status = 'active' and m.client_id = ${row.client_id}
      and m.id is distinct from coalesce(
        (select employee_id from bookings where id = ${row.booking_id}),
        (select created_by from trips where id = ${row.trip_id}))`)
  return found?.id ?? null
}

// The old row hands over; a new pending one, the same step, for the manager.
export async function escalate(db: Queryable, row: DueEscalation, managerId: string): Promise<string> {
  await exec(db, sql`update approvals set status = 'escalated', actioned_at = now() where id = ${row.id}`)
  return (await one<{ id: string }>(db, sql`
    insert into approvals (client_id, booking_id, trip_id, approver_id, tier, status, reason, chain_template_id, verdict, escalated_from)
    values (${row.client_id}, ${row.booking_id}, ${row.trip_id}, ${managerId}, ${row.tier}, 'pending', ${row.reason},
            ${row.chain_template_id}, ${row.verdict}, ${row.id})
    returning id`)).id
}

export async function pendingAtTier(db: Queryable, subject: Subject, tier: number): Promise<string[]> {
  const rows = await many<{ id: string }>(db, sql`
    select id from approvals where ${subjectIs(subject)} and tier = ${tier} and status = 'pending'
    order by id`)
  return rows.map(r => r.id)
}

// Parallel 'any' quorum: once one approves, the rest stop being live work.
export async function supersede(db: Queryable, approvalIds: readonly string[]): Promise<void> {
  if (approvalIds.length === 0) return
  await exec(db, sql`
    update approvals set status = 'superseded', actioned_at = now() where id = any(${[...approvalIds]})`)
}

export type ApprovalStep = Pick<Row<'approvals'>, 'id' | 'tier' | 'status' | 'reason' | 'decision_note' | 'approver_id'>

// The step a traveller cares about: the highest tier -- the one pending now,
// or the one decided last.
export async function latestForBooking(db: Queryable, bookingId: string): Promise<ApprovalStep | null> {
  return maybeOne<ApprovalStep>(db, sql`
    select id, tier, status, reason, decision_note, approver_id from approvals
    where booking_id = ${bookingId}
    order by tier desc, created_at desc, id
    limit 1`)
}

// A trip's sign-off as it went: every step, who it was asked of, what they
// decided and when -- earlier submissions included, oldest first.
export interface TripSignOffStep {
  id: string
  tier: number
  status: string
  approver_name: string | null
  decision_note: string | null
  actioned_at: string | null
  created_at: string
}

export async function stepsForTrip(db: Queryable, tripId: string): Promise<TripSignOffStep[]> {
  return many<TripSignOffStep>(db, sql`
    select a.id, a.tier, a.status, e.full_name as approver_name, a.decision_note, a.actioned_at, a.created_at
    from approvals a left join employees e on e.id = a.approver_id
    where a.trip_id = ${tripId}
    order by a.created_at, a.tier, a.id`)
}

export type ApprovalForDecision = Pick<Row<'approvals'>,
  'id' | 'booking_id' | 'trip_id' | 'client_id' | 'approver_id' | 'tier' | 'status' | 'chain_template_id' | 'verdict' | 'reason'>

export async function forDecision(db: Queryable, approvalId: string): Promise<ApprovalForDecision | null> {
  return maybeOne<ApprovalForDecision>(db, sql`
    select id, booking_id, trip_id, client_id, approver_id, tier, status, chain_template_id, verdict, reason
    from approvals where id = ${approvalId}`)
}

export async function decide(
  db: Queryable,
  approvalId: string,
  status: 'approved' | 'rejected',
  note: string | null
): Promise<void> {
  await exec(db, sql`
    update approvals set status = ${status}, decision_note = ${note}, actioned_at = now() where id = ${approvalId}`)
}

// A re-priced booking's verdict, cached on the step being decided.
export async function setVerdict(db: Queryable, approvalId: string, verdict: string | null, reason: string): Promise<void> {
  await exec(db, sql`update approvals set verdict = ${verdict}, reason = ${reason} where id = ${approvalId}`)
}

// ═══ The approver's queue ═══════════════════════════════════════════════════

export type QueueRow = Pick<Row<'approvals'>,
  'id' | 'booking_id' | 'trip_id' | 'tier' | 'status' | 'reason' | 'decision_note' | 'verdict' | 'actioned_at' | 'created_at'>
  // Who had this step before it was passed on (escalation), by name.
  & { escalated_from_name: string | null }

const QUEUE = sql`id, booking_id, trip_id, tier, status, reason, decision_note, verdict, actioned_at, created_at,
  (select e.full_name from approvals p join employees e on e.id = p.approver_id
   where p.id = approvals.escalated_from) as escalated_from_name`

// Both lists are paged: an approver for a large company (finance, an admin)
// can have thousands of decisions in a month.

// Oldest first: the ones that have waited longest surface at the top.
export async function pendingFor(
  db: Queryable, approverId: string, params: Pick<PageParams, 'from' | 'to'>
): Promise<{ rows: QueueRow[]; total: number }> {
  const where = sql`approver_id = ${approverId} and status = 'pending'`
  const [rows, count] = await Promise.all([
    many<QueueRow>(db, sql`select ${QUEUE} from approvals where ${where} order by created_at, id ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from approvals where ${where}`),
  ])
  return { rows, total: count.n }
}

// How many are waiting, and how many have waited since before `urgentBefore`:
// the dashboard's summary, counted rather than fetched.
export async function pendingCounts(
  db: Queryable, approverId: string, urgentBefore: string
): Promise<{ pending: number; urgent: number }> {
  return one(db, sql`
    select count(*)::int as pending, count(*) filter (where created_at <= ${urgentBefore})::int as urgent
    from approvals where approver_id = ${approverId} and status = 'pending'`)
}

export async function decidedSince(
  db: Queryable, approverId: string, since: string, params: Pick<PageParams, 'from' | 'to'>
): Promise<{ rows: QueueRow[]; total: number }> {
  const where = sql`approver_id = ${approverId} and status in ('approved', 'rejected') and actioned_at >= ${since}`
  const [rows, count] = await Promise.all([
    many<QueueRow>(db, sql`select ${QUEUE} from approvals where ${where} order by actioned_at desc, id ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from approvals where ${where}`),
  ])
  return { rows, total: count.n }
}
