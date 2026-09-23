import { describe, it, expect, beforeAll } from 'vitest'
import { requireTmcPermission, getAccessibleClientIds } from './requireTmcPermission'
import { db } from '@/app/lib/db'
import { sql, exec } from '@/app/lib/db/sql'
import { actors, type Actors } from '@/tests/harness/actors'
import { resetDatabase } from '@/tests/harness/db'

// ── requireTmcPermission / getAccessibleClientIds ────────────────────────────
// The gate on 46 files. Every branch that decides who may act for a TMC.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

// The connection the hubs are handed.
const conn = db

d('requireTmcPermission', () => {
  let a: Actors

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
  })

  it('a tmc_admin passes any permission', async () => {
    const r = await requireTmcPermission(conn, a.tmcAdmin.id, 'manage_deal_codes')
    expect(r).toEqual({ authorized: true, role: 'tmc_admin', tmcId: a.tmcAdmin.tmc_id })
  })

  it('a tc passes a permission they hold', async () => {
    const r = await requireTmcPermission(conn, a.tc!.id, 'manage_policy')
    expect(r).toEqual({ authorized: true, role: 'tc', tmcId: a.tc!.tmc_id })
  })

  it('a tc is refused a permission they lack', async () => {
    const r = await requireTmcPermission(conn, a.tc!.id, 'manage_deal_codes')
    expect(r).toEqual({ authorized: false, error: 'Missing permission: manage_deal_codes', status: 403 })
  })

  it('a tc with the permission passes for a client they can access', async () => {
    const [clientId] = await getAccessibleClientIds(conn, a.tc!.id, 'tc') as string[]
    const r = await requireTmcPermission(conn, a.tc!.id, 'manage_policy', clientId)
    expect(r.authorized).toBe(true)
  })

  it('a tc is refused a client they cannot access, even with the permission', async () => {
    const r = await requireTmcPermission(conn, a.tc!.id, 'manage_policy', '00000000-0000-0000-0000-000000000000')
    expect(r).toEqual({ authorized: false, error: 'No access to this client', status: 403 })
  })

  it('a corporate admin is Forbidden -- not TMC-side', async () => {
    const r = await requireTmcPermission(conn, a.corpAdmin.id, 'manage_policy')
    expect(r).toEqual({ authorized: false, error: 'Forbidden', status: 403 })
  })

  it('an unknown user is 404', async () => {
    const r = await requireTmcPermission(conn, '00000000-0000-0000-0000-000000000001', 'manage_policy')
    expect(r).toEqual({ authorized: false, error: 'Employee record not found', status: 404 })
  })

  it('a deactivated account is refused before anything else', async () => {
    await exec(db, sql`update employees set status = 'deactivated' where id = ${a.tc!.id}`)
    const r = await requireTmcPermission(conn, a.tc!.id, 'manage_policy')
    expect(r).toEqual({ authorized: false, error: 'This account has been deactivated', status: 403 })
    await exec(db, sql`update employees set status = 'active' where id = ${a.tc!.id}`)
  })
})

d('getAccessibleClientIds', () => {
  let a: Actors
  beforeAll(async () => { a = await actors() })

  it('a tmc_admin gets null -- every client of their TMC', async () => {
    expect(await getAccessibleClientIds(conn, a.tmcAdmin.id, 'tmc_admin')).toBeNull()
  })

  it('a tc gets exactly their granted clients', async () => {
    const ids = await getAccessibleClientIds(conn, a.tc!.id, 'tc')
    expect(Array.isArray(ids)).toBe(true)
    expect((ids as string[]).length).toBeGreaterThan(0)
    expect([...(ids as string[])].sort()).toMatchSnapshot()
  })

  it('a tc with no grants gets an empty list, not null', async () => {
    // Empty means "sees nothing", which is different from null ("sees all").
    expect(await getAccessibleClientIds(conn, '00000000-0000-0000-0000-000000000001', 'tc')).toEqual([])
  })
})
