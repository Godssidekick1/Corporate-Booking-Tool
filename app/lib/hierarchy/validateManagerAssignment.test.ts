import { describe, it, expect, beforeAll } from 'vitest'
import { validateManagerAssignment } from './validateManagerAssignment'
import { db } from '@/app/lib/db'
import { sql, many, exec } from '@/app/lib/db/sql'
import { resetDatabase } from '@/tests/harness/db'

// ── validateManagerAssignment ────────────────────────────────────────────────
// The rule that keeps the reporting chain a tree. A cycle here is not a data
// quality issue: resolveApproverForTier chases manager_id, and A managing B
// while B manages A would loop it.
//
// Builds its own chain A <- B <- C (C reports to B, B reports to A) inside one
// client of the test database.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const conn = db

d('validateManagerAssignment', () => {
  let clientId: string
  let A: string, B: string, C: string, D: string

  beforeAll(async () => {
    await resetDatabase()
    const top = await many<{ client_id: string }>(db, sql`
      select client_id from employees where client_id is not null
      group by client_id order by count(*) desc, client_id limit 1`)
    clientId = top[0].client_id
    const staff = await many<{ id: string }>(db, sql`
      select id from employees where client_id = ${clientId} order by created_at, id limit 4`)
    ;[A, B, C, D] = staff.map(s => s.id)

    await exec(db, sql`update employees set manager_id = null where client_id = ${clientId}`)
    await exec(db, sql`update employees set manager_id = ${A} where id = ${B}`)
    await exec(db, sql`update employees set manager_id = ${B} where id = ${C}`)
  })

  it('clearing the manager is always allowed', async () => {
    expect(await validateManagerAssignment(conn, C, clientId, null)).toEqual({ ok: true, managerId: null })
  })

  it('nobody manages themselves', async () => {
    expect(await validateManagerAssignment(conn, A, clientId, A))
      .toEqual({ ok: false, error: 'An employee cannot be their own manager.', status: 400 })
  })

  it('the manager must work at the same client', async () => {
    expect(await validateManagerAssignment(conn, A, clientId, '00000000-0000-0000-0000-000000000000'))
      .toEqual({ ok: false, error: 'Proposed manager not found in this client', status: 422 })
  })

  it('a valid assignment down the chain passes', async () => {
    // D reporting to C extends the tree; nothing loops.
    expect(await validateManagerAssignment(conn, D, clientId, C)).toEqual({ ok: true, managerId: C })
  })

  it('refuses a DIRECT loop: A cannot report to B when B reports to A', async () => {
    const r = await validateManagerAssignment(conn, A, clientId, B)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it('refuses an INDIRECT loop: A cannot report to C, two levels below it', async () => {
    const r = await validateManagerAssignment(conn, A, clientId, C)
    expect(r).toEqual({
      ok: false,
      error: 'This would create a circular reporting chain (the proposed manager already reports up to this employee).',
      status: 400,
    })
  })

  it('terminates on a cycle ALREADY in the data rather than hanging', async () => {
    // From some other bug: B and C manage each other. Assigning D to C must
    // still return, bounded by the depth limit.
    await exec(db, sql`update employees set manager_id = ${C} where id = ${B}`)
    const r = await validateManagerAssignment(conn, D, clientId, C)
    expect(r.ok).toBe(true)
    await exec(db, sql`update employees set manager_id = ${A} where id = ${B}`)
  })
})
