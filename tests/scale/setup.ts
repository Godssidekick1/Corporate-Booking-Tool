import pg from 'pg'
import { migrate } from '../../scripts/migrate.mjs'
import { templateUrl } from '../harness/testDatabase'

// ── npm run scale: database ──────────────────────────────────────────────────
// A fresh cbt_scale cloned from the (migrated) anonymised test template on
// every run. Never cbt_local, never cbt_test: the scale data is far too big to
// leave lying around for the normal suite.
// ─────────────────────────────────────────────────────────────────────────────

export const SCALE_DB = 'cbt_scale'

export default async function setup(): Promise<void> {
  await migrate(templateUrl(), { log: line => console.info(`[scale] cbt_template: ${line}`) })
  // Global setup runs outside the test workers, before the config's `env`
  // applies: DATABASE_URL here is still the developer's, from .env.local.
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = '/postgres'
  const admin = new pg.Client({ connectionString: url.toString() })
  await admin.connect()
  try {
    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [SCALE_DB])
    await admin.query(`drop database if exists ${SCALE_DB}`)
    await admin.query(`create database ${SCALE_DB} template cbt_template`)
  } finally {
    await admin.end()
  }
}
