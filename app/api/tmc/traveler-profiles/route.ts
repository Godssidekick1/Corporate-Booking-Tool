import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as bookings from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'

// ── GET /api/tmc/traveler-profiles?clientId=<uuid> ──────────────────────────
// Every employee at a client with the details the list needs up front — name,
// email, band, cost centre, department, designation — plus their trip count, so
// the roster is useful without opening anyone.
//
// The full traveler_profile jsonb comes along too. It is small, and fetching it
// per-row on tap would make the detail panel feel slower than it needs to.
// ─────────────────────────────────────────────────────────────────────────────

// Shared by the [id] and csv routes here, and by /api/tmc/cost-centres.
export async function authoriseClient(
  userId: string,
  clientId: string
): Promise<{ ok: true; tmcId: string } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(db, userId, 'manage_users', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  // A tmc_admin passes the permission check for any clientId, so the tenancy
  // boundary is checked explicitly.
  const client = await clients.tenancy(db, clientId)

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Client not found for this TMC', status: 404 }
  }

  return { ok: true, tmcId: auth.tmcId }
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) {
    return Response.json({ error: 'clientId is required' }, { status: 400 })
  }

  const access = await authoriseClient(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  // Bands and cost centres stay unpaged: they feed dropdowns inside the detail
  // panel, are bounded by how many a client defines, and paging them would mean
  // a round trip to open a select.
  const [{ rows, total }, bands, costCentres] = await Promise.all([
    employees.travellerRoster(db, clientId, ids.length > 0 ? { ids } : { search: params.search, page: params }),
    employees.bandsForClient(db, clientId),
    clients.costCentres(db, clientId),
  ])

  // Trip counts for the page's employees only. This previously pulled every
  // booking the client had ever made to count rows for a roster of ten.
  const tripsByEmployee = await bookings.tripCounts(db, clientId, rows.map(e => e.id))

  return Response.json({
    ...pagedResponse(
      rows.map(e => ({
        ...e,
        trips: tripsByEmployee.get(e.id) ?? 0,
        // A profile with no date of birth can't produce a valid passenger record,
        // so the list can flag who still needs completing.
        profileComplete: Boolean(e.traveler_profile?.dateOfBirth),
      })),
      total,
      params
    ),
    bands,
    costCentres,
  })
})
