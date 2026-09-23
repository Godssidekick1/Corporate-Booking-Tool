import { sql, maybeOne, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── TMCs and the platform ────────────────────────────────────────────────────
// Owns: tmcs, platform_admins, audit_log, branches.
//
// Branches belong here rather than with clients because they are the TMC's
// own offices (branches.tmc_id) -- a client is filed under one, but does not
// own it.
// ─────────────────────────────────────────────────────────────────────────────

// ═══ platform_admins ════════════════════════════════════════════════════════
// Amadeus staff. They have no employees row, deliberately -- they are not a
// member of any tenant -- so this is the only table that can say who they are.

export type PlatformAdminRow = Pick<Row<'platform_admins'>, 'user_id' | 'email'>

export async function platformAdmin(db: Queryable, userId: string): Promise<PlatformAdminRow | null> {
  return maybeOne<PlatformAdminRow>(db, sql`
    select user_id, email from platform_admins where user_id = ${userId}`)
}
