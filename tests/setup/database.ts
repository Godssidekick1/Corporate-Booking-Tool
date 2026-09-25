import { migrate } from '../../scripts/migrate.mjs'
import { recreateTestDatabase, templateUrl } from '../harness/testDatabase'

// Vitest globalSetup: bring cbt_template up to date with db/migrations, then
// one fresh cbt_test per run. Files that write and need pristine data mid-run
// call resetDatabase() from tests/harness/db.ts.
//
// Migrating the template here means a new migration is under test the moment
// it is written, without rebuilding the template from cbt_local.
export default async function setup(): Promise<void> {
  await migrate(templateUrl(), { log: line => console.info(`[tests] cbt_template: ${line}`) })
  await recreateTestDatabase()
}
