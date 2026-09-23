import { recreateTestDatabase } from '../harness/testDatabase'

// Vitest globalSetup: one fresh cbt_test per run. Files that write and need
// pristine data mid-run call resetDatabase() from tests/harness/db.ts.
export default async function setup(): Promise<void> {
  await recreateTestDatabase()
}
