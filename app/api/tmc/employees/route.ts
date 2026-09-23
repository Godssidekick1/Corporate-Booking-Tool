import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── GET /api/tmc/employees?clientId=<uuid> ──────────────────────────────────
// Lists a client's employees with their band, for TMC-side screens that need to
// pick or review one.
//
// Paged and server-searched, speaking the same `?search=` / `?ids=` protocol as
// every other picker endpoint so useLookup can drive it. That matters most here:
// a client with two thousand travellers was previously downloaded in full to
// populate a <select>, and picking a person meant scrolling a list nobody could
// scan.
//
// `?missingManager=1` narrows to people with no reporting line who are not
// marked top of hierarchy. The approval binder needs the COUNT of those, not the
// list, and asking for it as a filtered page means reading `total` instead of
// fetching everyone to run a filter in the browser.
//
// This replaces the listing half of the old employee-assignments route. The
// assignment half is gone for good: under the Policy Master model an employee's
// policy follows from their band rank and the groups linked to their client,
// so there is nothing per-employee left to assign.
// ─────────────────────────────────────────────────────────────────────────────

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

  // Passing clientId here also enforces per-client access for 'tc' callers,
  // not just the manage_policy permission itself.
  const auth = await requireTmcPermission(db, user.id, 'manage_policy', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  // Confirm the client belongs to the caller's TMC — a tmc_admin passes the
  // permission check for any clientId, so the tenancy boundary is checked here.
  const client = await clients.tenancy(db, clientId)

  if (!client || client.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Client not found for this TMC' }, { status: 404 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []
  const missingManager = req.nextUrl.searchParams.get('missingManager') === '1'

  // manager_id comes back so the hierarchy screen and the approval-step binder
  // can both show, and warn about, an employee with no reporting line — a
  // 'manager' step resolves to nobody without one.
  //
  // top_of_hierarchy alongside it, because "no manager" and "no manager BY
  // DESIGN" are different things: the person at the top has nobody above them
  // and the engine auto-approves their manager steps rather than stalling.
  // It was missing from this select, so every consumer reading it got undefined
  // and counted the owner of a client as a misconfiguration.
  const { rows: items, total } = await employees.roster(
    db,
    clientId,
    ids.length > 0 ? { ids } : { search: params.search, page: params },
    { missingManager }
  )

  // `employees` is kept alongside `items` because this route's callers predate
  // the paged envelope. Same array, two names — dropping the old one would break
  // them for no gain, and keeping it costs a reference.
  return Response.json({ ...pagedResponse(items, total, params), employees: items })
})
