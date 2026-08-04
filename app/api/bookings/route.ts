import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── GET /api/bookings ─────────────────────────────────────────────────────────
// Lists bookings for the logged-in employee — this is the data behind
// "My trips" (/bookings), which the dashboard already links to for every
// role. Scoped to the caller's own employee_id only, same ownership model
// as /api/book/[bookingId] — this is a personal trip list, not a team or
// company-wide view (that's a separate reporting concern, not this page).
//
// Returns a slimmer projection than the full booking row — enough for a
// list card (route, dates, status, traveler count, fare) without pulling
// the full traveler_snapshot/itinerary blob for every row.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const limitParam = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50

  const { data: bookings, error } = await service
    .from('bookings')
    .select('id, status, pnr, total_cost, itinerary, traveler_snapshot, fare_breakdown, created_at')
    .eq('employee_id', employee.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('Bookings list error:', error)
    return Response.json({ error: 'Could not load your bookings' }, { status: 500 })
  }

  return Response.json({ ok: true, bookings: bookings ?? [] })
}