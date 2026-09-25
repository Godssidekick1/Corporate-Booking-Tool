import { sql, exec, json, type Queryable } from '@/app/lib/db/sql'

// ── Audit trail ──────────────────────────────────────────────────────────────
// Owns: audit_log.
//
// Append-only. The first writers are the authentication events (sign-in,
// password changes, invites, revoked sessions), recorded by app/lib/auth.
// Metadata must never carry a password, a token or a hash.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  action: string
  entityType: string
  entityId: string
  // Who did it: the signed-in person, or null for an anonymous request.
  userId: string | null
  clientId?: string | null
  tmcId?: string | null
  metadata?: Record<string, unknown>
}

export async function append(db: Queryable, e: AuditEntry): Promise<void> {
  await exec(db, sql`
    insert into audit_log (client_id, tmc_id, user_id, action, entity_type, entity_id, metadata)
    values (${e.clientId ?? null}, ${e.tmcId ?? null}, ${e.userId}, ${e.action}, ${e.entityType},
            ${e.entityId}, ${json(e.metadata ?? {})})`)
}
