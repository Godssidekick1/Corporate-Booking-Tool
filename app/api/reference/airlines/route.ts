import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { parsePageParams, pagedResponse, ilikeAcross } from '@/app/lib/pagination'
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

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  let query = service
    .from('airlines')
    .select('code, name, last_seen_at', { count: 'exact' })
    .order('code')

  if (ids.length > 0) {
    query = query.in('code', ids.map(id => id.trim().toUpperCase()))
  } else {
    // Both columns: people look up "6E" and "IndiGo" about equally, and which
    // one they reach for depends entirely on whether they are reading a GDS
    // screen or talking to a colleague.
    const filter = ilikeAcross(['code', 'name'], params.search)
    if (filter) query = query.or(filter)
    query = query.range(params.from, params.to)
  }

  const { data: airlines, error, count } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // `id` mirrors `code` so the response speaks useLookup's shape without the
  // caller needing a custom toOption just to rename one field.
  const items = (airlines ?? []).map(a => ({ ...a, id: a.code }))

  return Response.json(pagedResponse(items, count ?? null, params))
}
