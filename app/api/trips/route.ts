import { createClient } from '@/utils/supabase/server'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as trips from '@/app/lib/repositories/trips'
import { route } from '@/app/lib/http/handler'

// ── /api/trips ──────────────────────────────────────────────────────────────
// A trip is a named container an employee creates to group everything for
// one journey — flights, hotels, misc expenses — built by repurposing the
// existing booking_groups table (originally scoped to multi-traveler group
// bookings; broadened here to cover both that case and single-traveler
// multi-service trips, since the shape is identical either way).
//
// Scoped to "my trips" only (created_by = current employee) — not every
// trip in the client. A manager wanting visibility into a report's trips
// is a different, later feature (would need its own permission check, not
// just relaxing this filter).
// ─────────────────────────────────────────────────────────────────────────────

interface CreateTripBody {
  name: string
}

export const GET = route(async () => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const employee = await employees.traveller(db, user.id)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  return Response.json({ ok: true, trips: await trips.mine(db, employee.client_id, employee.id) })
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const employee = await employees.traveller(db, user.id)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const body: CreateTripBody = await req.json()
  const name = body.name?.trim()

  if (!name) {
    return Response.json({ error: 'Trip name is required' }, { status: 400 })
  }

  // A trip belongs to a client; TMC staff have none and cannot hold one.
  if (!employee.client_id) {
    return Response.json({ error: 'Could not create trip' }, { status: 500 })
  }

  const trip = await trips.create(db, { client_id: employee.client_id, created_by: employee.id, name })

  return Response.json({ ok: true, trip })
})
