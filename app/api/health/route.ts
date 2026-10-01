import { db } from '@/app/lib/db'
import * as system from '@/app/lib/repositories/system'
import { mailMode } from '@/app/lib/mail'

// ── GET /api/health ──────────────────────────────────────────────────────────
// Can this deployment serve sign-ins? One request answers it without anyone
// opening logs or holding database credentials:
//
//   database         reachable, or the PostgreSQL / network error CODE
//   schema           the auth tables exist (the 20260926* migrations ran)
//   passwordHashing  the native argon2 module loads on this platform
//   email            which transport invites and resets would use
//   appUrl           NEXT_PUBLIC_APP_URL is set (links in emails need it)
//
// Codes and booleans only: never a connection string, host, message text or
// version. 200 when everything sign-in needs is in place, 503 otherwise, so a
// load balancer or uptime check can use it as is.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic'

// What a connection or query failure most likely means, by its code.
const HINTS: Record<string, string> = {
  '28P01': 'password rejected: check the password in DATABASE_URL (special characters must be URL-encoded)',
  '28000': 'role rejected: check the user name in DATABASE_URL',
  '3D000': 'database does not exist: check the database name in DATABASE_URL',
  ENOTFOUND: 'host not found: check the host in DATABASE_URL',
  ECONNREFUSED: 'connection refused: check the host and port in DATABASE_URL',
  ETIMEDOUT: 'connection timed out: check the host and port in DATABASE_URL',
  DATABASE_URL_MISSING: 'DATABASE_URL is not set in this environment',
  DATABASE_URL_INVALID: 'DATABASE_URL is not a valid URL (special characters in the password must be URL-encoded)',
}

function codeOf(err: unknown): string {
  const e = err as { code?: unknown } | null
  return typeof e?.code === 'string' ? e.code : 'UNKNOWN'
}

export async function GET() {
  const report: Record<string, unknown> = {}
  let ok = true

  try {
    const schema = await system.schemaState(db)
    report.database = { ok: true }
    report.schema = {
      ok: schema.missingTables.length === 0,
      appliedMigrations: schema.appliedMigrations,
      ...(schema.missingTables.length > 0 && {
        missingTables: schema.missingTables,
        hint: 'run the migrations against this database: npm run migrate',
      }),
    }
    if (schema.missingTables.length > 0) ok = false
  } catch (err) {
    const code = codeOf(err)
    report.database = { ok: false, code, hint: HINTS[code] ?? 'see the server log' }
    ok = false
    console.error('[health] database check failed', err)
  }

  try {
    const { hashPassword } = await import('@/app/lib/auth/password')
    await hashPassword('health check')
    report.passwordHashing = { ok: true }
  } catch (err) {
    report.passwordHashing = { ok: false, hint: 'the argon2 native module did not load on this platform' }
    ok = false
    console.error('[health] password hashing failed', err)
  }

  const email = mailMode()
  report.email = { transport: email, ...(email === 'none' && { hint: 'invites and resets fail: set SMTP_URL and MAIL_FROM, or MAIL_TRANSPORT=log for testing' }) }
  report.appUrl = { set: Boolean(process.env.NEXT_PUBLIC_APP_URL) }

  return Response.json({ ok, ...report }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } })
}
