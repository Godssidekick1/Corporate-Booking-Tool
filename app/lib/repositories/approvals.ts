import { sql, empty, json, join, many, maybeOne, one, exec, type Queryable, type Sql } from '@/app/lib/db/sql'
import { assignments } from '@/app/lib/db/fragments'
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

export interface NewApproval {
  client_id: string
  booking_id: string
  approver_id: string
  tier: number
  status: 'pending' | 'approved'
  reason: string
  chain_template_id: string
  verdict: string
  // Set for rows logged as already approved (self, top of hierarchy).
  actioned: boolean
}

export async function raise(
  db: Queryable,
  rows: readonly NewApproval[]
): Promise<Pick<Row<'approvals'>, 'id' | 'approver_id'>[]> {
  if (rows.length === 0) return []
  return many(db, sql`
    insert into approvals (client_id, booking_id, approver_id, tier, status, reason, chain_template_id, verdict, actioned_at)
    values ${join(rows.map(r => sql`(
      ${r.client_id}, ${r.booking_id}, ${r.approver_id}, ${r.tier}, ${r.status}, ${r.reason},
      ${r.chain_template_id}, ${r.verdict}, ${r.actioned ? sql`now()` : sql`null`})`))}
    returning id, approver_id`)
}

export async function pendingAtTier(db: Queryable, bookingId: string, tier: number): Promise<string[]> {
  const rows = await many<{ id: string }>(db, sql`
    select id from approvals where booking_id = ${bookingId} and tier = ${tier} and status = 'pending'
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

export type ApprovalForDecision = Pick<Row<'approvals'>,
  'id' | 'booking_id' | 'client_id' | 'approver_id' | 'tier' | 'status' | 'chain_template_id' | 'verdict' | 'reason'>

export async function forDecision(db: Queryable, approvalId: string): Promise<ApprovalForDecision | null> {
  return maybeOne<ApprovalForDecision>(db, sql`
    select id, booking_id, client_id, approver_id, tier, status, chain_template_id, verdict, reason
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
  'id' | 'booking_id' | 'tier' | 'status' | 'reason' | 'decision_note' | 'verdict' | 'actioned_at' | 'created_at'>

const QUEUE = sql`id, booking_id, tier, status, reason, decision_note, verdict, actioned_at, created_at`

// Oldest first: the ones that have waited longest surface at the top.
export async function pendingFor(db: Queryable, approverId: string): Promise<QueueRow[]> {
  return many<QueueRow>(db, sql`
    select ${QUEUE} from approvals where approver_id = ${approverId} and status = 'pending'
    order by created_at, id`)
}

export async function decidedSince(db: Queryable, approverId: string, since: string): Promise<QueueRow[]> {
  return many<QueueRow>(db, sql`
    select ${QUEUE} from approvals
    where approver_id = ${approverId} and status in ('approved', 'rejected') and actioned_at >= ${since}
    order by actioned_at desc, id`)
}
