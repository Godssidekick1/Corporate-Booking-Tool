import { describe, it, expect, beforeAll } from 'vitest'
import { harvestAirlines } from './harvestAirlines'
import type { FlightResult } from '@/app/lib/amadeus/client'
import { db } from '@/app/lib/db'
import { sql, maybeOne } from '@/app/lib/db/sql'
import { resetDatabase } from '@/tests/harness/db'

// ── harvestAirlines ──────────────────────────────────────────────────────────
// The two rules in its header are the contract: it never throws, and a
// carrier seen only as someone else's OPERATING carrier must not overwrite a
// real name recorded earlier.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

interface AirlineRow { code: string; name: string; first_seen_at: string; last_seen_at: string }

const airline = (code: string) =>
  maybeOne<AirlineRow>(db, sql`select code, name, first_seen_at, last_seen_at from airlines where code = ${code}`)

function flight(legs: { Code: string; Name?: string; OperatingCarrier?: string }[]): FlightResult {
  return { Itineraries: { Itinerary: legs.map(AirLine => ({ AirLine })) } } as unknown as FlightResult
}

d('harvestAirlines', () => {
  beforeAll(resetDatabase)

  it('records a new named carrier and a new operating-only carrier', async () => {
    await harvestAirlines([flight([{ Code: 'zx', Name: 'Zed Air', OperatingCarrier: 'ZY' }])])

    expect((await airline('ZX'))?.name).toBe('Zed Air')
    // Operating carrier with no name of its own gets its code as a placeholder.
    expect((await airline('ZY'))?.name).toBe('ZY')
  })

  it('never overwrites a real name with an operating-carrier placeholder', async () => {
    const before = await airline('AI')
    expect(before?.name).toBe('Air India')

    await harvestAirlines([flight([{ Code: 'ZX', Name: 'Zed Air', OperatingCarrier: 'AI' }])])

    const after = await airline('AI')
    expect(after?.name).toBe('Air India')
    // Seen again, so touched -- but first seen is history and must not move.
    expect(after!.last_seen_at > before!.last_seen_at).toBe(true)
    expect(after!.first_seen_at).toBe(before!.first_seen_at)
  })

  it('updates the name of a named carrier seen again', async () => {
    await harvestAirlines([flight([{ Code: 'ZX', Name: 'Zed Air Renamed' }])])
    expect((await airline('ZX'))?.name).toBe('Zed Air Renamed')
  })

  it('never throws, even on malformed input', async () => {
    await expect(harvestAirlines([{} as FlightResult, null as unknown as FlightResult])).resolves.toBeUndefined()
  })
})
