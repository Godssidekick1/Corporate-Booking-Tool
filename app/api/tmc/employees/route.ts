import { requireUser } from '@/app/lib/auth/session'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { addEmployee, isEmployeeRole } from '@/app/lib/onboarding/addEmployee'
import { inviteFailure } from '@/app/lib/onboarding/onboardTmc'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
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
  const user = await requireUser()

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

// ── POST /api/tmc/employees ─────────────────────────────────────────────────
// Adds one person to a client by hand -- name, email, role and band, the
// minimum a booking and the approval engine need. Everything else (cost centre,
// reporting line, passport and contact details) is filled in on Traveller
// profiles afterwards.
//
// Same rules as every other way people are added (addEmployee): they are
// emailed an invite to set a password, whatever the client's booking mode.
// ─────────────────────────────────────────────────────────────────────────────

interface AddBody {
  clientId?: string
  fullName?: string
  email?: string
  role?: string
  band?: string
}

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser()
  const body: AddBody = await req.json()
  const clientId = body.clientId

  if (!clientId) {
    return Response.json({ error: 'clientId is required' }, { status: 400 })
  }

  // The same permission as editing a traveller profile, with per-client access
  // enforced for 'tc' callers.
  const auth = await requireTmcPermission(db, user.id, 'manage_users', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const client = await clients.tenancy(db, clientId)
  if (!client || client.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Client not found for this TMC' }, { status: 404 })
  }

  const fullName = body.fullName?.trim()
  const email = body.email?.trim().toLowerCase()
  if (!fullName || !email) {
    return Response.json({ error: 'Name and email are required' }, { status: 400 })
  }
  if (!email.includes('@') || !email.includes('.')) {
    return Response.json({ error: 'Invalid email address' }, { status: 400 })
  }

  const role = body.role?.trim().toLowerCase() || 'employee'
  if (!isEmployeeRole(role)) {
    return Response.json({ error: `Invalid role: ${body.role}` }, { status: 400 })
  }

  const bandCode = body.band?.trim()
  if (!bandCode) {
    return Response.json({ error: 'Band is required' }, { status: 400 })
  }
  const band = await employees.bandByCode(db, clientId, bandCode)
  if (!band) {
    return Response.json({ error: `Band "${bandCode}" is not configured for this client` }, { status: 422 })
  }

  if (await employees.findByEmailInClient(db, clientId, email)) {
    return Response.json({ error: 'Someone at this client already has this email' }, { status: 409 })
  }

  try {
    const employeeId = await transaction(
      tx => addEmployee(tx, { clientId, band, email, fullName, role, setup: 'invite', createdBy: user.id }),
      { tenantId: auth.tmcId, userId: user.id }
    )
    return Response.json({
      ok: true,
      employeeId,
      message: `${fullName} added. Invite sent to ${email}.`,
    }, { status: 201 })
  } catch (err) {
    const failure = inviteFailure(err)
    if (failure) return Response.json({ error: failure.error }, { status: failure.status })
    // Two people adding the same person at once: the unique constraint decides.
    if (isConstraint(err, 'unique', 'employees_company_email_unique')) {
      return Response.json({ error: 'Someone at this client already has this email' }, { status: 409 })
    }
    throw err
  }
})
