import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as reference from '@/app/lib/repositories/reference'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'

// ── GET /api/reference/cities?country=IN&region=16&search=mum ────────────────
// Places whose name starts with the search, biggest first, at most 20: the
// list has about 225,000 entries, so it is searched here, never sent whole.
// `loaded` says whether this database has the list at all
// (scripts/load-cities.mjs) -- without it the city field stays free text.
// Data: GeoNames (CC BY 4.0).
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  await requireUser()
  const p = req.nextUrl.searchParams
  const country = p.get('country')?.trim().toUpperCase()
  if (!country) return Response.json({ error: 'country is required' }, { status: 400 })

  const [loaded, cities] = await Promise.all([
    reference.hasCities(db, country),
    reference.searchCities(db, country, { regionCode: p.get('region') || null, search: p.get('search') ?? '' }),
  ])
  return Response.json({ ok: true, loaded, cities })
})
