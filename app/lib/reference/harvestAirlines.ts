import { createServiceClient } from '@/utils/supabase/service'
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

    const service = createServiceClient()
    const now = new Date().toISOString()

    // first_seen_at is deliberately ABSENT from every payload below. PostgREST
    // builds its ON CONFLICT DO UPDATE SET clause from the keys actually sent,
    // so leaving it out means the column keeps its existing value on an update
    // and takes its `now()` default on an insert. Sending it would reset the
    // first-seen date on every single search.
    if (named.size > 0) {
      const { error } = await service
        .from('airlines')
        .upsert(
          [...named.entries()].map(([code, name]) => ({ code, name, last_seen_at: now })),
          { onConflict: 'code' }
        )
      if (error) throw new Error(error.message)
    }

    if (unnamed.size > 0) {
      const codes = [...unnamed]

      // Insert-only for these. Writing the code as a placeholder name is fine
      // for a carrier we have never seen named, but it must not overwrite a real
      // name recorded earlier — which a plain upsert would do the first time a
      // known airline appears only as somebody else's operating carrier.
      const { error: insertError } = await service
        .from('airlines')
        .upsert(
          codes.map(code => ({ code, name: code, last_seen_at: now })),
          { onConflict: 'code', ignoreDuplicates: true }
        )
      if (insertError) throw new Error(insertError.message)

      // Which leaves last_seen_at unmoved for the ones that already existed, so
      // it is refreshed separately. One statement over a handful of codes.
      const { error: touchError } = await service
        .from('airlines')
        .update({ last_seen_at: now })
        .in('code', codes)
      if (touchError) throw new Error(touchError.message)
    }
  } catch (error) {
    // Swallowed on purpose. Rule 1 above.
    console.error('[airlines] harvest failed', error)
  }
}
