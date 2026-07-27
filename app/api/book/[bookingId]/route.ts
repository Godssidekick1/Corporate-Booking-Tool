import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── GET /api/book/[bookingId] ─────────────────────────────────────────────────
// Fetches a single booking row. Added alongside the confirm/ticket pages,
// which need to load booking state from a URL (bookingId) rather than
// carrying it through sessionStorage the way earlier steps do — once a row
// exists, the database is the source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { bookingId } = await params

  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { data: booking } = await service
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle()

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (booking.employee_id !== employee.id) {
    return Response.json({ error: 'Not authorized to view this booking' }, { status: 403 })
  }

  return Response.json({ ok: true, booking })
}