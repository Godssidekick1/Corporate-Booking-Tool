import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── /api/trips ──────────────────────────────────────────────────────────────
// A trip is a named container an employee creates to group everything for
// one journey — flights, hotels, misc expenses — built by repurposing the
// existing booking_groups table (originally scoped to multi-traveler group
// bookings; broadened here to cover both that case and single-traveler
// multi-service trips, since the shape is identical either way).
//
// Scoped to "my trips" only (created_by = current employee) — not every
// trip in the company. A manager wanting visibility into a report's trips
// is a different, later feature (would need its own permission check, not
// just relaxing this filter).
// ─────────────────────────────────────────────────────────────────────────────

interface CreateTripBody {
  name: string
}

export async function GET() {
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

  const { data: trips, error } = await service
    .from('trips')
    .select('id, name, status, travel_date, created_at, updated_at')
    .eq('company_id', employee.company_id)
    .eq('created_by', employee.id)
    .neq('status', 'deleted')
    .order('updated_at', { ascending: false })

  if (error) {
    console.error('Failed to list trips', error)
    return Response.json({ error: 'Could not load trips' }, { status: 500 })
  }

  return Response.json({ ok: true, trips })
}

export async function POST(req: NextRequest) {
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

  const body: CreateTripBody = await req.json()
  const name = body.name?.trim()

  if (!name) {
    return Response.json({ error: 'Trip name is required' }, { status: 400 })
  }

  const { data: trip, error } = await service
    .from('trips')
    .insert({
      company_id: employee.company_id,
      created_by: employee.id,
      name,
      status: 'open',
    })
    .select('id, name, status')
    .single()

  if (error || !trip) {
    console.error('Failed to create trip', error)
    return Response.json({ error: 'Could not create trip' }, { status: 500 })
  }

  return Response.json({ ok: true, trip })
}