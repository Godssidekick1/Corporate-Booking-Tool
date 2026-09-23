import { closePool } from '@/app/lib/db/pool'
import { recreateTestDatabase } from './testDatabase'

// For a test file that writes and must not see another file's writes: drops
// the pool (so no connection pins the old database), re-clones cbt_test from
// the template, and lets the next query open a fresh pool against it.
export async function resetDatabase(): Promise<void> {
  await closePool()
  await recreateTestDatabase()
}
