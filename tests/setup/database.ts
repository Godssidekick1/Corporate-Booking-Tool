import pg from 'pg'
import { migrate } from '../../scripts/migrate.mjs'
import { recreateTestDatabase, templateUrl } from '../harness/testDatabase'

// Vitest globalSetup: bring cbt_template up to date with db/migrations, then
// one fresh cbt_test per run. Files that write and need pristine data mid-run
// call resetDatabase() from tests/harness/db.ts.
//
// Migrating the template here means a new migration is under test the moment
// it is written, without rebuilding the template from cbt_local.
//
// The tests connect as cbt_app_test, a login in the restricted cbt_app role
// (vitest.config.mts). It is created here if missing and given this run's
// random password, so the suite always runs with the app's real privileges.
export default async function setup(): Promise<void> {
  await migrate(templateUrl(), { log: line => console.info(`[tests] cbt_template: ${line}`) })

  const admin = new pg.Client({ connectionString: templateUrl() })
  await admin.connect()
  try {
    const password = process.env.TEST_APP_PASSWORD
    if (!password) throw new Error('[tests] TEST_APP_PASSWORD is not set (vitest.config.mts sets it)')
    const exists = (await admin.query(`select 1 from pg_roles where rolname = 'cbt_app_test'`)).rowCount
    // A password is a literal in CREATE/ALTER ROLE (no bind parameters there):
    // quoted with the server's own quote_literal, never by hand.
    const literal = (await admin.query('select quote_literal($1) as q', [password])).rows[0].q
    await admin.query(exists
      ? `alter role cbt_app_test login inherit password ${literal}`
      : `create role cbt_app_test login inherit password ${literal} in role cbt_app`)
    await admin.query('grant cbt_app to cbt_app_test')
    // The limits the deployed login carries (docs/database-roles.md), so the
    // suite proves nothing the app does needs longer than they allow.
    await admin.query(`alter role cbt_app_test set statement_timeout = '15s'`)
    await admin.query(`alter role cbt_app_test set idle_in_transaction_session_timeout = '30s'`)
  } finally {
    await admin.end()
  }

  await recreateTestDatabase()
}
