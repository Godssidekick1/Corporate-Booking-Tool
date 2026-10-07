import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as reference from '@/app/lib/repositories/reference'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'

// ── GET /api/reference/airports?search=mum  |  ?code=BOM ─────────────────────
// Airports for the flight search pickers: matches for a search (code, city,
// airport name or country; best first, at most 40), or the one airport with a
// code (null when there is none). Data: OurAirports (public domain).
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  await requireUser()
  const p = req.nextUrl.searchParams
  const code = p.get('code')
  if (code !== null) return Response.json({ ok: true, airport: await reference.findAirport(db, code) })
  return Response.json({ ok: true, airports: await reference.searchAirports(db, (p.get('search') ?? '').slice(0, 80)) })
})
