import { sql, one, type Queryable } from '@/app/lib/db/sql'

// ── The database's own state ─────────────────────────────────────────────────
// Owns: schema_migrations (read only; scripts/migrate.mjs writes it).
//
// For /api/health: can the application reach the database, and has the
// schema it expects been migrated in? Answers with names and counts only.
// ─────────────────────────────────────────────────────────────────────────────

// Tables the authentication layer cannot work without. A deployment whose
// database has not had the 20260926* migrations applied lacks them.
const REQUIRED = ['accounts', 'sessions', 'auth_tokens', 'auth_attempts'] as const

export interface SchemaState {
  missingTables: string[]
  appliedMigrations: number
}

export async function schemaState(db: Queryable): Promise<SchemaState> {
  const row = await one<{ missing: string[]; tracked: boolean }>(db, sql`
    select
      array(select t from unnest(${[...REQUIRED]}::text[]) t
            where to_regclass('public.' || t) is null) as missing,
      to_regclass('public.schema_migrations') is not null as tracked`)
  // A separate query: a statement naming a table that does not exist fails at
  // parse time, even inside a branch that would never run.
  const applied = row.tracked
    ? (await one<{ n: number }>(db, sql`select count(*)::int as n from schema_migrations`)).n
    : 0
  return { missingTables: row.missing, appliedMigrations: applied }
}
