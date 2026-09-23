import { createClient } from '@/utils/supabase/server'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { db } from '@/app/lib/db'
import * as reference from '@/app/lib/repositories/reference'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'

// ── GET /api/reference/airlines ──────────────────────────────────────────────
// Carriers seen in flight searches, for the deal code and FOP pickers.
//
// Under /api/reference rather than /api/tmc because this is not TMC-scoped
// data: the table is global, and which airlines exist is a fact about the world
// rather than about a tenant. Any signed-in user may read it.
//
// AUTHENTICATED, BUT NOT PERMISSION-GATED. There is nothing here to protect —
// airline codes are public. The auth check exists so the endpoint is not an open
// window into the database for anyone who finds the URL, not because the content
// is sensitive. Requiring manage_deal_codes would be false precision, and would
// break the moment another screen wants the same list.
//
// `?ids=` takes CODES, not UUIDs — the code IS the primary key here, which is
// what lets a free-typed value round-trip through the picker unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  // `id` mirrors `code` so the response speaks useLookup's shape without the
  // caller needing a custom toOption just to rename one field.
  const withId = (a: reference.Airline) => ({ ...a, id: a.code })

  // Resolving specific codes for a picker's labels: every match, unpaged.
  if (ids.length > 0) {
    const rows = await reference.airlinesByCode(db, ids)
    return Response.json(pagedResponse(rows.map(withId), rows.length, params))
  }

  const { rows, total } = await reference.listAirlines(db, params)
  return Response.json(pagedResponse(rows.map(withId), total, params))
})
