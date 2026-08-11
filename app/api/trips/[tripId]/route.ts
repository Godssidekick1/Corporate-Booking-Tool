import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// GET /api/trips/[tripId] — one trip's workspace: the trip itself, every
// booking attached to it (flights, and hotels/cabs once those exist), and
// every misc expense logged against it.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ tripId: string }> }
) {
  const { tripId } = await params

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id, company_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { data: trip } = await service
    .from('trips')
    .select('id, name, status, travel_date, created_by, company_id, created_at')
    .eq('id', tripId)
    .maybeSingle()

  if (!trip) {
    return Response.json({ error: 'Trip not found' }, { status: 404 })
  }

  // Same-owner-only for now, matching the list route's scoping.
  if (trip.created_by !== employee.id) {
    return Response.json({ error: 'Not authorized to view this trip' }, { status: 403 })
  }

  const { data: bookings } = await service
    .from('bookings')
    .select('id, booking_type, status, total_cost, provider_order_id, pnr, itinerary, created_at')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true })

  const { data: expenses } = await service
    .from('trip_expenses')
    .select('id, expense_type, amount, currency, description, expense_date, created_at')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true })

  return Response.json({
    ok: true,
    trip,
    bookings: bookings ?? [],
    expenses: expenses ?? [],
  })
}

// ── DELETE /api/trips/[tripId] ────────────────────────────────────────────
// Soft-delete only — sets status: 'deleted' rather than removing the row.
// A trip can have real bookings (PNRs, money already spent with an airline)
// and trip_expenses attached via trip_id; hard-deleting would either orphan
// those children or cascade-delete real financial records. 'deleted' is
// kept distinct from 'cancelled' (which means the travel itself was called
// off) so a draft someone abandons and a booked trip that fell through stay
// separable in reporting later. The list route filters status: 'deleted'
// out by default.

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ tripId: string }> }
) {
  const { tripId } = await params

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

  const { data: trip } = await service
    .from('trips')
    .select('id, created_by, status')
    .eq('id', tripId)
    .maybeSingle()

  if (!trip) {
    return Response.json({ error: 'Trip not found' }, { status: 404 })
  }

  if (trip.created_by !== employee.id) {
    return Response.json({ error: 'Not authorized to delete this trip' }, { status: 403 })
  }

  if (trip.status === 'deleted') {
    return Response.json({ ok: true, trip: { id: trip.id, status: 'deleted' } })
  }

  const { data: updated, error } = await service
    .from('trips')
    .update({ status: 'deleted' })
    .eq('id', tripId)
    .select('id, status')
    .single()

  if (error || !updated) {
    console.error('Failed to delete trip', error)
    return Response.json({ error: 'Could not delete trip' }, { status: 500 })
  }

  return Response.json({ ok: true, trip: updated })
}