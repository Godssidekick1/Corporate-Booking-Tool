import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── GET /api/bookings/recent ─────────────────────────────────────────────────
// Feeds the dashboard's "Recent bookings" widget. Distinct from
// /api/bookings (which powers /bookings — "My trips", always personal-
// scoped) because visibility here depends on role:
//
//   employee — own bookings only
//   manager / finance — own bookings, plus bookings made by their direct
//                        reports (employees.manager_id === this employee)
//   admin — every booking in the company
//
// Returns a slim projection (route/dates/status/fare/traveler name) rather
// than full traveler_snapshot/itinerary — enough for a preview card list,
// not a detail view.
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
    .select('id, role, company_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const limitParam = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 5

  let employeeIds: string[]

  if (employee.role === 'admin') {
    const { data: companyEmployees } = await service
      .from('employees')
      .select('id')
      .eq('company_id', employee.company_id)
    employeeIds = (companyEmployees ?? []).map(e => e.id)
  } else if (employee.role === 'manager' || employee.role === 'finance') {
    const { data: directReports } = await service
      .from('employees')
      .select('id')
      .eq('manager_id', employee.id)
    employeeIds = [employee.id, ...(directReports ?? []).map(e => e.id)]
  } else {
    employeeIds = [employee.id]
  }

  if (employeeIds.length === 0) {
    return Response.json({ ok: true, bookings: [] })
  }

  const { data: bookings, error } = await service
    .from('bookings')
    .select('id, employee_id, status, pnr, total_cost, itinerary, fare_breakdown, created_at')
    .in('employee_id', employeeIds)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('Recent bookings error:', error)
    return Response.json({ error: 'Could not load recent bookings' }, { status: 500 })
  }

  // Traveler names for display — only fetch the employees actually present
  // in this page of results, not the whole employeeIds scope (which for
  // admin could be the entire company).
  const travelerIds = Array.from(new Set((bookings ?? []).map(b => b.employee_id)))
  const { data: travelers } = await service
    .from('employees')
    .select('id, full_name')
    .in('id', travelerIds)

  const nameById = new Map((travelers ?? []).map(t => [t.id, t.full_name]))

  const result = (bookings ?? []).map(b => ({
    id: b.id,
    status: b.status,
    pnr: b.pnr,
    totalCost: b.total_cost,
    itinerary: b.itinerary,
    fareBreakdown: b.fare_breakdown,
    createdAt: b.created_at,
    travelerName: nameById.get(b.employee_id) ?? null,
    isOwn: b.employee_id === employee.id,
  }))

  return Response.json({ ok: true, bookings: result })
}