import { describe, it, expect, beforeAll } from 'vitest'
import { resolveApproverForTier, type ChainTier } from '@/app/lib/approval-engine/resolveApprovalTier'
import { actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, exec } from '@/app/lib/db/sql'

// ── Who counts as a candidate ────────────────────────────────────────────────
// The half of approver resolution that lives in SQL: active people only, at
// THIS client only, in the right role, ranked by THIS client's bands. The
// ranking itself is pickApprover's and is tested purely next to it.
//
// A scratch client of its own, so the template's real people cannot win by
// accident.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const tier = (overrides: Partial<ChainTier>): ChainTier =>
  ({ tier: 1, approver_type: 'any_manager_at', min_verdict: 'amber', ...overrides })

d('approver candidates', () => {
  let client: string
  let other: string
  let n = 0

  async function person(clientId: string, fields: { role: string; status?: string; band?: string | null; created?: string }) {
    n += 1
    return (await one<{ id: string }>(db, sql`
      insert into employees (id, client_id, full_name, email, role, status, band_code, created_at)
      values (gen_random_uuid(), ${clientId}, ${`Person ${n}`}, ${`person${n}@example.test`}, ${fields.role},
              ${fields.status ?? 'active'}, ${fields.band ?? null}, ${fields.created ?? '2024-01-01'})
      returning id`)).id
  }

  beforeAll(async () => {
    await resetDatabase()
    const a = await actors()
    client = (await one<{ id: string }>(db, sql`
      insert into clients (tmc_id, name) values (${a.tmcAdmin.tmc_id}, 'Approver Co') returning id`)).id
    other = (await one<{ id: string }>(db, sql`
      insert into clients (tmc_id, name) values (${a.tmcAdmin.tmc_id}, 'Other Co') returning id`)).id
    await exec(db, sql`
      insert into bands (client_id, code, label, rank) values
        (${client}, 'L2', 'Two', 2), (${client}, 'L4', 'Four', 4), (${other}, 'L9', 'Nine', 9)`)
  })

  it('only active managers and admins at this client, ranked by its own bands', async () => {
    const inactive = await person(client, { role: 'manager', status: 'deactivated', band: 'L2' })
    const elsewhere = await person(other, { role: 'manager', band: 'L2' })
    const employee = await person(client, { role: 'employee', band: 'L2' })
    // Band L9 exists only at the OTHER client: no rank here, so excluded.
    const foreignBand = await person(client, { role: 'manager', band: 'L9' })
    const admin = await person(client, { role: 'admin', band: 'L4' })

    const result = await resolveApproverForTier(db, tier({ min_band_rank: 1 }), 'traveller', client)
    // Every excluded person would outrank or tie the admin if they leaked in.
    expect(result).toEqual({ kind: 'approver', approverId: admin })
    expect([inactive, elsewhere, employee, foreignBand]).not.toContain((result as { approverId: string }).approverId)
  })

  it('finance and admin steps take the longest-serving active holder of the role', async () => {
    await person(client, { role: 'finance', created: '2024-06-01' })
    const oldest = await person(client, { role: 'finance', created: '2023-01-01' })
    await person(client, { role: 'finance', status: 'deactivated', created: '2020-01-01' })
    expect(await resolveApproverForTier(db, tier({ approver_type: 'finance_role' }), 't', client))
      .toEqual({ kind: 'approver', approverId: oldest })
    expect(await resolveApproverForTier(db, tier({ approver_type: 'finance_role' }), 't', other))
      .toEqual({ kind: 'unresolved' })
  })

  it('a manager step follows the traveller\'s own reporting line', async () => {
    const boss = await person(client, { role: 'manager', band: 'L4' })
    const traveller = await person(client, { role: 'employee', band: 'L2' })
    await exec(db, sql`update employees set manager_id = ${boss} where id = ${traveller}`)
    expect(await resolveApproverForTier(db, tier({ approver_type: 'manager' }), traveller, client))
      .toEqual({ kind: 'approver', approverId: boss })

    const top = await person(client, { role: 'admin', band: 'L4' })
    await exec(db, sql`update employees set top_of_hierarchy = true where id = ${top}`)
    expect((await resolveApproverForTier(db, tier({ approver_type: 'manager' }), top, client)).kind).toBe('no_approval_needed')
  })
})
