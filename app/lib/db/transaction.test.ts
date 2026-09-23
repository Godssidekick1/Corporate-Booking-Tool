import { describe, it, expect, afterAll } from 'vitest'
import { sql, exec, many, maybeOne } from './sql'
import { db, isConstraint } from './index'
import { transaction } from './transaction'
import { closePool } from './pool'

// ── transaction() ────────────────────────────────────────────────────────────
// The reason this migration exists. Ported from the shim's withTransaction
// tests, which are deleted with the shim.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const codes = (list: string[]) =>
  many<{ code: string }>(db, sql`select code from airlines where code = any(${list}) order by code`)

d('transaction', () => {
  afterAll(async () => {
    await exec(db, sql`delete from airlines where code = any(${['T1', 'T2', 'T3']})`)
    await closePool()
  })

  it('commits every write when the callback returns', async () => {
    const result = await transaction(async tx => {
      await exec(tx, sql`insert into airlines (code, name) values ('T1', 'One')`)
      await exec(tx, sql`insert into airlines (code, name) values ('T2', 'Two')`)
      return 'done'
    })
    expect(result).toBe('done')
    expect(await codes(['T1', 'T2'])).toHaveLength(2)
  })

  it('ROLLS BACK every write when the callback throws, and rethrows', async () => {
    await exec(db, sql`delete from airlines where code = any(${['T1', 'T2']})`)

    await expect(transaction(async tx => {
      await exec(tx, sql`insert into airlines (code, name) values ('T1', 'One')`)
      await exec(tx, sql`insert into airlines (code, name) values ('T2', 'Two')`)
      throw new Error('deliberate')
    })).rejects.toThrow('deliberate')

    expect(await codes(['T1', 'T2'])).toEqual([])
  })

  it('a constraint violation mid-way rolls back the earlier write and surfaces the violation', async () => {
    // The replace-wholesale shape: an earlier write succeeds, a later one hits
    // a constraint. No TxAbort, no orAbort -- the repository throw IS the abort.
    await exec(db, sql`insert into airlines (code, name) values ('T3', 'Existing') on conflict do nothing`)

    const err = await transaction(async tx => {
      await exec(tx, sql`insert into airlines (code, name) values ('T1', 'One')`)
      await exec(tx, sql`insert into airlines (code, name) values ('T3', 'Duplicate')`)
    }).catch(e => e)

    expect(isConstraint(err, 'unique')).toBe(true)
    expect(await codes(['T1'])).toEqual([])
  })

  it('reads inside the transaction see its own uncommitted writes', async () => {
    await transaction(async tx => {
      await exec(tx, sql`insert into airlines (code, name) values ('T1', 'Visible')`)
      const row = await maybeOne<{ name: string }>(tx, sql`select name from airlines where code = 'T1'`)
      expect(row?.name).toBe('Visible')
      throw new Error('roll back')
    }).catch(() => undefined)
    expect(await codes(['T1'])).toEqual([])
  })

  it('sets the tenant GUC for the transaction only -- it cannot leak to the next borrower', async () => {
    const inside = await transaction(
      async tx => maybeOne<{ v: string }>(tx, sql`select current_setting('app.current_tenant_id', true) as v`),
      { tenantId: 'tenant-abc' }
    )
    expect(inside?.v).toBe('tenant-abc')

    // Every pooled connection is checked: none may still carry it.
    for (let i = 0; i < 5; i++) {
      const after = await maybeOne<{ v: string | null }>(db, sql`select current_setting('app.current_tenant_id', true) as v`)
      expect(after?.v === null || after?.v === '').toBe(true)
    }
  })
})
