import { requireUser } from '@/app/lib/auth/session'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as bookings from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'
import { CLIENT_ROLES, isClientRole } from '@/app/lib/clients/roles'

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
  const user = await requireUser()

  const clientId = req.nextUrl.searchParams.get('clientId')
  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []
  // ?role=admin: the corporate admins only (the "Admins only" filter).
  const role = req.nextUrl.searchParams.get('role')
  if (role && !isClientRole(role)) {
    return Response.json({ error: `role must be one of ${CLIENT_ROLES.join(', ')}` }, { status: 400 })
  }
  const roleFilter = role ? [role] : undefined

  // ── No client chosen: everyone the caller can reach ───────────────────────
  // Every client of the TMC for a TMC admin, the portfolio for a counsellor,
  // each row naming its client. No bands or cost centres here: those belong
  // to one client, and the page asks for them when a person is opened.
  if (!clientId) {
    const auth = await requireTmcPermission(db, user.id, 'manage_users')
    if (!auth.authorized || !auth.tmcId) {
      return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
    }
    const clientIds = await getAccessibleClientIds(db, user.id, auth.role ?? 'tc')
    const { rows, total } = await employees.travellerRosterAcross(
      db, { tmcId: auth.tmcId, clientIds }, ids.length > 0 ? { ids } : { search: params.search, page: params }, roleFilter)
    const trips = await bookings.tripCountsFor(db, rows.map(e => e.id))
    return Response.json({
      ...pagedResponse(
        rows.map(e => ({ ...e, trips: trips.get(e.id) ?? 0, profileComplete: Boolean(e.traveler_profile?.dateOfBirth) })),
        total,
        params
      ),
      bands: [],
      costCentres: [],
    })
  }

  const access = await authoriseClient(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Bands and cost centres stay unpaged: they feed dropdowns inside the detail
  // panel, are bounded by how many a client defines, and paging them would mean
  // a round trip to open a select.
  const [{ rows, total }, bands, costCentres] = await Promise.all([
    employees.travellerRoster(db, clientId, ids.length > 0 ? { ids } : { search: params.search, page: params }, roleFilter),
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
