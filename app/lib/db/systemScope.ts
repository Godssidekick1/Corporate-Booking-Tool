import type { Queryable } from './sql'
import { asSystem, currentContext, contextValues } from './context'
import { db } from './index'

// ── Queries on the sign-in tables, always as the system ──────────────────────
// accounts, sessions, auth_tokens, auth_attempts, platform_admins and
// rate_limits hold no tenant's rows, so row-level security admits them to the
// system scope only (20261102000000_sign_in_tables_system_only). Yet some of
// their writes happen inside a tenant's request: adding an employee creates
// their account, deactivating someone ends their sessions, a signed-in user
// changes their password or signs out, every route counts its rate limit.
//
// The repositories for those tables pass their connection through onSystem(),
// so the guarantee lives where the tables are read, not at every caller:
//   the pool        the query runs inside asSystem()
//   a transaction   the scope is switched to system for that one statement,
//                   local to the transaction, and the request's own settings
//                   put straight back. The account a tenant's transaction
//                   creates is still part of that transaction: one commit, or
//                   one rollback, for both.
// Nothing else in the app can see these tables from a tenant's request.
// ─────────────────────────────────────────────────────────────────────────────

const SET = "select set_config('app.scope', $1, true), set_config('app.tmc_id', $2, true), set_config('app.client_id', $3, true)"
const SYSTEM_VALUES = ['system', '', '']

export function onSystem(q: Queryable): Queryable {
  if (q === db) return { query: (text, values) => asSystem(() => db.query(text, values)) }
  return {
    async query(text, values) {
      await q.query(SET, SYSTEM_VALUES)
      try {
        return await q.query(text, values)
      } finally {
        // A failed statement aborts the transaction, which then refuses this
        // too; the abort discards the settings anyway.
        await q.query(SET, contextValues(currentContext())).catch(() => {})
      }
    },
  }
}
