import pg from 'pg'

// ── The test database lifecycle ──────────────────────────────────────────────
// cbt_test is cloned from cbt_template -- the anonymised copy built by
// scripts/make-test-template.mjs. Cloning a template is a file copy, so it
// takes about a second rather than a restore's minutes.
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPLATE = 'cbt_template'
export const TEST_DB = 'cbt_test'

function adminUrl(): string {
  const url = process.env.TEST_ADMIN_DATABASE_URL
  if (url) return url
  const base = process.env.DATABASE_URL
  if (!base) throw new Error('[tests] DATABASE_URL is not set')
  const u = new URL(base)
  u.pathname = '/postgres'
  return u.toString()
}

export async function recreateTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() })
  await admin.connect()
  try {
    const { rows } = await admin.query('select 1 from pg_database where datname = $1', [TEMPLATE])
    if (rows.length === 0) {
      throw new Error(
        `[tests] ${TEMPLATE} does not exist. Build it once with:\n` +
        `  node scripts/make-test-template.mjs\n` +
        `(stop the dev server first -- it clones cbt_local).`
      )
    }
    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [TEST_DB]
    )
    await admin.query(`drop database if exists ${TEST_DB}`)
    await admin.query(`create database ${TEST_DB} template ${TEMPLATE}`)
  } finally {
    await admin.end()
  }
}
