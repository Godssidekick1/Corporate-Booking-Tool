import { describe, it, expect, afterAll } from 'vitest'
import { transaction } from '@/app/lib/db/transaction'
import { closePool } from '@/app/lib/db/pool'

// ── The schema, as a test ────────────────────────────────────────────────────
// Runs against cbt_test, which globalSetup has brought up to date with
// db/migrations. Keeps the schema free of Supabase auth, and keeps the tables
// closed to every role but the owner.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

async function rows<T>(text: string): Promise<T[]> {
  return transaction(async tx => (await tx.query(text)).rows as T[])
}

d('schema', () => {
  afterAll(async () => { await closePool() })

  it('no policy, function or view in public refers to the auth schema', async () => {
    const found = await rows<{ what: string }>(`
      select 'policy ' || tablename || '.' || policyname as what from pg_policies
       where schemaname = 'public' and (coalesce(qual, '') || coalesce(with_check, '')) ~ '\\mauth\\.'
      union all
      select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc ~ '\\mauth\\.'
      union all
      select 'view ' || viewname from pg_views where schemaname = 'public' and definition ~ '\\mauth\\.'`)
    expect(found.map(r => r.what)).toEqual([])
  })

  it('no foreign key reaches into the auth schema', async () => {
    // A local restore never had these (auth.users does not exist there); this
    // is what stops one coming back.
    const found = await rows<{ fk: string }>(`
      select conrelid::regclass || '.' || conname as fk from pg_constraint
       where contype = 'f' and confrelid::regclass::text like 'auth.%'`)
    expect(found.map(r => r.fk)).toEqual([])
  })

  it('every table in public has row level security enabled', async () => {
    // With no policies, that is deny-by-default for any role but the owner.
    const open = await rows<{ t: string }>(`
      select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
       order by 1`)
    expect(open.map(r => r.t)).toEqual([])
  })

  it("Supabase's API roles hold no privilege on public", async () => {
    const granted = await rows<{ g: string }>(`
      select grantee || ' ' || privilege_type || ' ' || table_name as g
        from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
       order by 1`)
    expect(granted.map(r => r.g)).toEqual([])
  })
})
