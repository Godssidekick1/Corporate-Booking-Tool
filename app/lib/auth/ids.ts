import { randomUUID } from 'node:crypto'

// ── Account ids ──────────────────────────────────────────────────────────────
// A new account's id, which also becomes its employees.id. Random. Takes the
// email only so that tests/setup/auth.ts can replace this with an id derived
// from it: characterisation snapshots include the ids of people a test
// creates, and a random one would differ on every run.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the seam tests replace
export function newAccountId(_email: string): string {
  return randomUUID()
}
