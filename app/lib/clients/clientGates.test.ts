import { describe, it, expect, beforeAll } from 'vitest'
import { loadClientGates, type ClientGates } from './clientGates'
import { db } from '@/app/lib/db'
import { sql, exec } from '@/app/lib/db/sql'
import { actors, type Actors } from '@/tests/harness/actors'
import { resetDatabase } from '@/tests/harness/db'

// ── loadClientGates ──────────────────────────────────────────────────────────
// The Corporate Settings switches that actually stop something. Two things
// matter most: an inactive client closes every gate, and an unreadable client
// fails OPEN -- except for personal bookings and commercial kinds, which fail
// closed for the reasons given in clientGates.ts.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

const conn = db

// Sets do not snapshot readably; arrays do.
const plain = (g: ClientGates) => ({
  ...g,
  allowedPayers: [...g.allowedPayers].sort(),
  allowedPaymentTypes: [...g.allowedPaymentTypes].sort(),
  enabledCommercialKinds: [...g.enabledCommercialKinds].sort(),
})

d('loadClientGates', () => {
  let a: Actors

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
  })

  it('reads a real client', async () => {
    expect(plain(await loadClientGates(conn, a.corpAdmin.client_id))).toMatchSnapshot()
  })

  it('no client id is permissive', async () => {
    expect(plain(await loadClientGates(conn, null))).toMatchSnapshot()
  })

  it('an unknown client is permissive, identically', async () => {
    expect(plain(await loadClientGates(conn, '00000000-0000-0000-0000-000000000000')))
      .toEqual(plain(await loadClientGates(conn, null)))
  })

  it('an inactive client closes booking and ticketing, whatever the switches say', async () => {
    await exec(db, sql`update clients set status = 'inactive' where id = ${a.corpAdmin.client_id}`)
    const g = await loadClientGates(conn, a.corpAdmin.client_id)
    expect(g.active).toBe(false)
    expect(g.bookingActivation).toBe(false)
    expect(g.domTicketing).toBe(false)
    expect(g.intlTicketing).toBe(false)
    await exec(db, sql`update clients set status = 'active' where id = ${a.corpAdmin.client_id}`)
  })
})
