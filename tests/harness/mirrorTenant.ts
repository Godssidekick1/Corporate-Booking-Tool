import { randomUUID } from 'node:crypto'
import { db } from '@/app/lib/db'

// ── mirrorTenant ─────────────────────────────────────────────────────────────
// Copies one TMC's configuration and clients into another TMC, with new ids,
// every reference remapped to the copy. For cross-tenant tests: the template
// has one well-stocked TMC and a second that is empty, and an attacker with
// nothing of their own cannot exercise a create route at all -- every request
// fails validation long before the tenant check under test.
//
// Generic over the tables listed (in dependency order): each row whose tenant
// is the source is copied; a uuid column naming a row already copied is
// rewritten to the copy; one naming anything else outside the copy (an
// account, a creator) is set to null where it may be, so nothing in the copy
// points back at the source tenant.
// ─────────────────────────────────────────────────────────────────────────────

// [table, how to find the source tenant's rows]
const TABLES: [string, string][] = [
  ['client_groups', 'tmc_id = $1'],
  ['branches', 'tmc_id = $1'],
  ['buckets', 'tmc_id = $1'],
  ['deal_code_categories', 'tmc_id = $1'],
  ['deal_code_category_types', 'category_id in (select id from deal_code_categories where tmc_id = $1)'],
  ['fop_payment_types', 'tmc_id = $1'],
  ['fop_gds_entries', 'tmc_id = $1'],
  ['clients', 'tmc_id = $1'],
  ['bucket_clients', 'client_id in (select id from clients where tmc_id = $1)'],
  ['cost_centres', 'client_id in (select id from clients where tmc_id = $1)'],
  ['bands', 'client_id in (select id from clients where tmc_id = $1)'],
  ['employees', `client_id in (select id from clients where tmc_id = $1)`],
  ['deal_codes', 'tmc_id = $1'],
  ['deal_code_assignments', 'tmc_id = $1'],
  ['forms_of_payment', 'tmc_id = $1'],
  ['fop_assignments', 'tmc_id = $1'],
  ['commercial_rules', 'tmc_id = $1'],
  ['commercial_rule_assignments', 'tmc_id = $1'],
  ['policy_groups', 'tmc_id = $1'],
  ['policy_group_band_ranks', 'policy_group_id in (select id from policy_groups where tmc_id = $1)'],
  ['client_policy_groups', 'client_id in (select id from clients where tmc_id = $1)'],
  ['approval_chain_templates', 'tmc_id = $1'],
]

// Rows every TMC is given its own of (seeded on first use): matched to the
// target's row with the same code rather than copied.
const MATCH_BY_CODE = new Set(['deal_code_categories', 'fop_payment_types', 'fop_gds_entries'])
// Copied only where their parent was copied, not matched.
const CHILD_OF_COPIED: Record<string, string> = { deal_code_category_types: 'category_id' }

// Columns never copied as they are.
const DROP = new Set(['auth_user_id', 'manager_id', 'invited_by', 'created_by', 'updated_by', 'approver_user_id'])

export async function mirrorTenant(fromTmc: string, toTmc: string): Promise<{ copied: Record<string, number> }> {
  const idMap = new Map<string, string>([[fromTmc, toTmc]])
  const fresh = new Set<string>()
  const copied: Record<string, number> = {}

  for (const [table, where] of TABLES) {
    const { rows: columns } = await db.query(`
      select column_name, data_type, is_nullable = 'YES' as nullable from information_schema.columns
      where table_schema = 'public' and table_name = $1`, [table])
    const uuidCols = columns.filter(c => c.data_type === 'uuid').map(c => c.column_name as string)
    const nullable = new Set(columns.filter(c => c.nullable).map(c => c.column_name as string))
    const hasId = columns.some(c => c.column_name === 'id')

    const { rows } = await db.query(`select row_to_json(t) as r from ${table} t where ${where}`, [fromTmc])
    const existing = MATCH_BY_CODE.has(table)
      ? new Map((await db.query(`select code, id from ${table} where tmc_id = $1`, [toTmc])).rows.map(e => [e.code as string, e.id as string]))
      : new Map<string, string>()
    const out: Record<string, unknown>[] = []
    for (const { r } of rows as { r: Record<string, unknown> }[]) {
      const match = existing.get(r.code as string)
      if (match) { idMap.set(r.id as string, match); continue }
      const parentCol = CHILD_OF_COPIED[table]
      if (parentCol && !fresh.has(idMap.get(r[parentCol] as string) ?? '')) continue
      const row = { ...r }
      if (hasId) {
        const id = randomUUID()
        idMap.set(row.id as string, id)
        fresh.add(id)
        row.id = id
      }
      for (const col of uuidCols) {
        if (col === 'id' || row[col] == null) continue
        const mapped = idMap.get(row[col] as string)
        if (mapped) row[col] = mapped
        else if (DROP.has(col) || nullable.has(col)) row[col] = null
      }
      for (const col of DROP) if (col in row && nullable.has(col)) row[col] = null
      // Unique per tenant already; emails are unique per client, which is new.
      out.push(row)
    }
    if (out.length) {
      await db.query(`insert into ${table} select * from jsonb_populate_recordset(null::${table}, $1::jsonb)`, [JSON.stringify(out)])
    }
    copied[table] = out.length
  }
  return { copied }
}
