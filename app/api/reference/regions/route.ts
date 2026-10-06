import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as reference from '@/app/lib/repositories/reference'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'

// ── GET /api/reference/regions?country=IN ────────────────────────────────────
// A country's states or provinces, for the state picker. Data: GeoNames.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  await requireUser()
  const country = req.nextUrl.searchParams.get('country')?.trim().toUpperCase()
  if (!country) return Response.json({ error: 'country is required' }, { status: 400 })
  return Response.json({ ok: true, regions: await reference.listRegions(db, country) })
})
