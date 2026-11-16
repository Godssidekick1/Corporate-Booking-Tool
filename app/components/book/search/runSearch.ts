import { apiDate, displayDate, type SearchQuery } from '@/app/lib/book/searchQuery'
import { flowStorage, type SplitResults } from '@/app/lib/book/flowStorage'
import { searchPreferences } from '@/app/lib/book/searchPreferences'
import type { FlatFlightResult } from '@/app/lib/book/types'

// ── One flight search, asked of /api/book/search ─────────────────────────────
// Run by the results page, on arrival and from its edit bar. Who it is for
// (booking for a colleague) comes from the flow, never from the address. A
// list that comes back is saved for the later steps (the fare page finds its
// flight in it) and for "Back to results".
// ─────────────────────────────────────────────────────────────────────────────

export interface Found {
  results: FlatFlightResult[]
  // A domestic round trip: two columns and the special return fares.
  split: SplitResults | null
  hiddenByPolicy: { code: string; name: string }[]
}

export type SearchOutcome = ({ ok: true } & Found) | { ok: false; error: string }

export async function runSearch(q: SearchQuery): Promise<SearchOutcome> {
  let res: Response
  let data: Record<string, unknown> & { results?: FlatFlightResult[] }
  try {
    res = await fetch('/api/book/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Booking for someone else: whose (bookingActor); absent = oneself.
        travellerId: flowStorage.travellerId(),
        origin: q.origin,
        destination: q.destination,
        departDate: apiDate(q.departDate),
        tripType: q.returnDate ? 'return' : 'oneway',
        returnDate: q.returnDate ? apiDate(q.returnDate) : undefined,
        cabin: q.cabin,
        adult: q.adult, child: q.child, infant: q.infant,
      }),
    })
    data = await res.json()
  } catch {
    return { ok: false, error: 'The search did not go through. Check your connection and try again.' }
  }
  if (!res.ok) {
    // The airline's own wording comes back to the travel desk only
    // (app/lib/book/providerErrors.ts); everyone else gets the plain line.
    const provider = data.provider as { message?: string } | undefined
    const forDesk = provider?.message ? ` Airline system: ${provider.message}` : ''
    return { ok: false, error: `${typeof data.error === 'string' ? data.error : 'Search failed.'}${forDesk}` }
  }

  const results = data.results ?? []
  const split: SplitResults | null = data.kind === 'split'
    ? {
        onward: (data.onward as SplitResults['onward']) ?? null,
        return: (data.return as SplitResults['return']) ?? null,
        specialReturn: (data.specialReturn as SplitResults['specialReturn']) ?? null,
        notes: (data.notes as string[]) ?? [],
      }
    : null
  const hiddenByPolicy = (data.hiddenByPolicy as Found['hiddenByPolicy']) ?? []

  searchPreferences.saveLastSearch({
    origin: q.origin, destination: q.destination, adult: q.adult, child: q.child, infant: q.infant, cabinPref: q.cabin,
  })
  flowStorage.saveSearchResults(
    results,
    {
      origin: q.origin, destination: q.destination,
      departDate: displayDate(q.departDate),
      tripType: q.returnDate ? 'return' : 'oneway',
      returnDate: q.returnDate ? displayDate(q.returnDate) : undefined,
      adult: q.adult, child: q.child, infant: q.infant,
      query: q,
    },
    typeof data.availabilityKey === 'string' ? data.availabilityKey : null,
    split ?? undefined,
    hiddenByPolicy,
  )
  return { ok: true, results, split, hiddenByPolicy }
}
