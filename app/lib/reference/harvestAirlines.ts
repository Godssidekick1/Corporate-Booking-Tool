import { db } from '@/app/lib/db'
import * as reference from '@/app/lib/repositories/reference'
import type { FlightResult } from '@/app/lib/amadeus/client'
import { normaliseAirlineCode } from './airlineCode'

// ── harvestAirlines ──────────────────────────────────────────────────────────
// Records every carrier seen in a flight search response.
//
// WHY IT READS THE RAW RESULTS RATHER THAN THE MAPPED ONES
// The search route flattens each result down to a single `airline` — the FIRST
// leg's carrier. Harvesting from that would silently miss the operating carrier
// on every connecting itinerary, which is exactly the long tail this exists to
// capture: a codeshare whose onward leg is a different airline entirely. So this
// takes the raw flights and walks every leg.
//
// TWO RULES IT MUST NEVER BREAK
//
//   1. It cannot throw. A booking search failing because a reference upsert
//      failed would be an absurd trade, so everything is caught and logged.
//      There is no rejection for a caller to handle.
//
//   2. It cannot add latency. The caller schedules it with Next's `after()`,
//      which runs it once the response has been sent. Nothing here is on the
//      path the traveller waits for.
// ─────────────────────────────────────────────────────────────────────────────

export async function harvestAirlines(flights: FlightResult[]): Promise<void> {
  try {
    // Deduped in memory first: a search with thirty results routinely carries
    // the same six carriers over and over.
    //
    // Two buckets, because a name and a code are not equally trustworthy. The
    // response's `Name` belongs to the MARKETING carrier, so attaching it to a
    // different OperatingCarrier would file "9I" under "Air India" — a wrong
    // label on a row that deal codes match against.
    const named = new Map<string, string>()
    const unnamed = new Set<string>()

    for (const flight of flights) {
      for (const leg of flight.Itineraries?.Itinerary ?? []) {
        const airline = leg.AirLine
        if (!airline) continue

        const marketing = normaliseAirlineCode(airline.Code)
        const name = airline.Name?.trim()

        if (marketing) {
          if (name) named.set(marketing, name)
          else unnamed.add(marketing)
        }

        // The operating carrier is recorded too — a deal code can legitimately
        // name either — but without a name, since we do not have its own.
        const operating = normaliseAirlineCode(airline.OperatingCarrier)
        if (operating && operating !== marketing) unnamed.add(operating)
      }
    }

    // A code that turned up named somewhere in this response does not need the
    // nameless treatment as well.
    for (const code of named.keys()) unnamed.delete(code)

    if (named.size === 0 && unnamed.size === 0) return

    const now = new Date().toISOString()

    // The rules about first_seen_at (never written) and placeholder names
    // (never overwriting a real one) live in the repository functions, where
    // the SQL that enforces them is.
    await reference.upsertNamedAirlines(
      db,
      [...named.entries()].map(([code, name]) => ({ code, name })),
      now
    )
    await reference.recordUnnamedAirlines(db, [...unnamed], now)
  } catch (error) {
    // Swallowed on purpose. Rule 1 above.
    console.error('[airlines] harvest failed', error)
  }
}
