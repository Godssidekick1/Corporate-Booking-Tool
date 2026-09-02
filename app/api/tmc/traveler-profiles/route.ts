import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/traveler-profiles?clientId=<uuid> ──────────────────────────
// Every employee at a client with the details the list needs up front — name,
// email, band, cost centre, department, designation — plus their trip count, so
// the roster is useful without opening anyone.
//
// The full traveler_profile jsonb comes along too. It is small, and fetching it
// per-row on tap would make the detail panel feel slower than it needs to.
// ─────────────────────────────────────────────────────────────────────────────

export async function authoriseClient(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  clientId: string
): Promise<{ ok: true; tmcId: string } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(service, userId, 'manage_users', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  // A tmc_admin passes the permission check for any clientId, so the tenancy
  // boundary is checked explicitly.
  const { data: client } = await service
    .from('clients')
    .select('id, tmc_id')
    .eq('id', clientId)
    .maybeSingle()

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Client not found for this TMC', status: 404 }
  }

  return { ok: true, tmcId: auth.tmcId }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) {
    return Response.json({ error: 'clientId is required' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authoriseClient(service, user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const [{ data: employees, error }, { data: bands }, { data: costCentres }, { data: bookings }] =
    await Promise.all([
      service
        .from('employees')
        .select('id, full_name, email, role, status, band_code, band_rank, department, cost_centre, designation, manager_id, top_of_hierarchy, traveler_profile, first_login_completed')
        .eq('client_id', clientId)
        .order('full_name'),
      service.from('bands').select('id, code, label, rank').eq('client_id', clientId).order('rank'),
      service.from('cost_centres').select('id, code, name').eq('client_id', clientId).order('code'),
      service.from('bookings').select('employee_id').eq('client_id', clientId),
    ])

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const tripsByEmployee = new Map<string, number>()
  for (const b of bookings ?? []) {
    if (!b.employee_id) continue
    tripsByEmployee.set(b.employee_id, (tripsByEmployee.get(b.employee_id) ?? 0) + 1)
  }

  return Response.json({
    ok: true,
    employees: (employees ?? []).map(e => ({
      ...e,
      trips: tripsByEmployee.get(e.id) ?? 0,
      // A profile with no date of birth can't produce a valid passenger record,
      // so the list can flag who still needs completing.
      profileComplete: Boolean(
        (e.traveler_profile as Record<string, unknown> | null)?.dateOfBirth
      ),
    })),
    bands: bands ?? [],
    costCentres: costCentres ?? [],
  })
}
