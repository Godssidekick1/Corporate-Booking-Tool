import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import {
  getAssignmentsForClient,
  getBandAssignmentsForClient,
} from '@/app/lib/approval-engine/linkedApprovalTemplates'
import { APPROVAL_CATEGORIES } from '@/app/lib/approval-engine/resolveApprovalTier'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as approvals from '@/app/lib/repositories/approvals'
import * as clients from '@/app/lib/repositories/clients'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── GET /api/tmc/approval-assignments?clientId=<uuid> ───────────────────────
// The whole client's approval routing in one payload — all three rungs of the
// ladder: every employee with their explicit assignment per category, every
// band with its own, and the client defaults that cover anyone left.
//
// Returned as one roster rather than per-employee so the screen can show who
// routes where at a glance, and support selecting several people at once —
// the previous design needed a client pick, an employee pick and two saves
// for every single person.
//
// ── POST /api/tmc/approval-assignments ───────────────────────────────────────
// Assigns a template at one rung of the ladder. With `employeeIds`, to those
// employees (any number at once); with `bandCode`, to everyone in that band;
// with neither, sets the client default. Passing a null templateId clears.
//
// ── DELETE ?clientId=&category=&employeeId= ─────────────────────────────────
// Clears one employee's assignment, one band's, or the client default,
// depending on which of employeeId / bandCode is supplied.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = APPROVAL_CATEGORIES as readonly string[]

interface AssignBody {
  clientId: string
  category: string
  templateId: string | null
  employeeIds?: string[]
  // Set instead of employeeIds to assign at the band level — the middle rung of
  // employee -> band -> client default. Exactly one of the two, or neither for
  // the client default.
  bandCode?: string
}

async function authorise(
  userId: string,
  clientId: string
): Promise<{ ok: true; tmcId: string } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(db, userId, 'manage_approvals', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  // tmc_admin passes the permission check for any clientId, so the tenancy
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

  const access = await authorise(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const roster = await employees.routingRoster(db, clientId)

  const [assignments, bandAssignments, defaults, bands] = await Promise.all([
    getAssignmentsForClient(db, roster.map(e => e.id)),
    getBandAssignmentsForClient(db, clientId),
    approvals.defaultAssignments(db, clientId),
    employees.bandsForClient(db, clientId),
  ])

  return Response.json({
    ok: true,
    employees: roster.map(e => ({
      ...e,
      // null here means "inherited" — from their band if that band has an
      // assignment, otherwise from the client default. The UI shows which, so an
      // admin can tell a deliberate choice from something they are getting by
      // virtue of where they sit.
      assignments: Object.fromEntries(
        CATEGORIES.map(c => [c, assignments.get(`${e.id}::${c}`) ?? null])
      ),
    })),
    bands: bands.map(b => ({
      code: b.code,
      label: b.label,
      rank: b.rank,
      assignments: Object.fromEntries(
        CATEGORIES.map(c => [c, bandAssignments.get(`${b.code}::${c}`) ?? null])
      ),
    })),
    defaults: Object.fromEntries(
      CATEGORIES.map(c => [c, defaults.find(d => d.category === c)?.template_id ?? null])
    ),
  })
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: AssignBody = await req.json()
  const { clientId, category, templateId, employeeIds, bandCode } = body

  if (!clientId || !category) {
    return Response.json({ error: 'clientId and category are required' }, { status: 400 })
  }
  if (!CATEGORIES.includes(category)) {
    return Response.json({ error: `Invalid category: ${category}` }, { status: 400 })
  }
  // Refused rather than silently preferring one. Sending both would mean the
  // caller does not know which rung it is writing to, and quietly picking would
  // leave the other one unset without saying so.
  if (bandCode && Array.isArray(employeeIds) && employeeIds.length > 0) {
    return Response.json(
      { error: 'Assign to employees or to a band, not both in one request' },
      { status: 400 }
    )
  }

  const access = await authorise(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // A template from another TMC would route this client's bookings to
  // approvers who don't work there.
  //
  // The "that template routes X, not Y" check that used to sit here is gone
  // along with approval_chain_templates.category. A chain is a sequence of steps
  // and verdict thresholds — nothing in it is air-specific or hotel-specific, so
  // one chain can now serve all three categories instead of being duplicated per
  // category and drifting the first time somebody edits one copy.
  if (templateId) {
    const template = await approvals.ownership(db, templateId)

    if (!template || template.tmc_id !== access.tmcId) {
      return Response.json({ error: 'Approval template not found for this TMC' }, { status: 404 })
    }
  }

  const assignedBy = (await employees.traveller(db, user.id))?.id ?? null

  // ── Per-employee assignment (possibly bulk) ────────────────────────────────
  if (Array.isArray(employeeIds) && employeeIds.length > 0) {
    // Confirm every id actually belongs to this client before writing any of
    // them, so a forged id can't attach an assignment to someone else's staff.
    const verifiedIds = await employees.idsInClientAmong(db, clientId, employeeIds)

    if (verifiedIds.length !== employeeIds.length) {
      return Response.json({ error: 'One or more employees do not belong to this client' }, { status: 400 })
    }

    if (templateId === null) {
      await approvals.clearEmployees(db, verifiedIds, category)
      return Response.json({ ok: true, cleared: verifiedIds.length })
    }

    await approvals.assignToEmployees(db, verifiedIds, category, templateId, assignedBy)
    return Response.json({ ok: true, assigned: verifiedIds.length })
  }

  // ── Band assignment ───────────────────────────────────────────────────────
  if (bandCode) {
    // Verified against this client's own bands. band_code is text, and the
    // composite FK to bands only exists where the schema supports it, so an
    // unrecognised code would otherwise be accepted here and then match nobody
    // at resolution time — a routing rule that silently does nothing.
    const band = await employees.bandByCode(db, clientId, bandCode)

    if (!band) {
      return Response.json({ error: `"${bandCode}" is not a band at this client` }, { status: 400 })
    }

    if (templateId === null) {
      await approvals.clearBand(db, clientId, bandCode, category)
      return Response.json({ ok: true, bandCleared: true })
    }

    await approvals.assignToBand(db, clientId, bandCode, category, templateId, assignedBy)
    return Response.json({ ok: true, bandSet: true })
  }

  // ── Client default ────────────────────────────────────────────────────────
  if (templateId === null) {
    await approvals.clearDefault(db, clientId, category)
    return Response.json({ ok: true, defaultCleared: true })
  }

  await approvals.assignDefault(db, clientId, category, templateId, assignedBy)
  return Response.json({ ok: true, defaultSet: true })
})

export const DELETE = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  const category = req.nextUrl.searchParams.get('category')
  const employeeId = req.nextUrl.searchParams.get('employeeId')
  const bandCode = req.nextUrl.searchParams.get('bandCode')

  if (!clientId || !category) {
    return Response.json({ error: 'clientId and category are required' }, { status: 400 })
  }

  const access = await authorise(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  if (bandCode) {
    await approvals.clearBand(db, clientId, bandCode, category)
    return Response.json({ ok: true })
  }

  if (employeeId) {
    // The employee must work at THIS client. The rest of this handler is
    // scoped by clientId; this branch keyed only on employee_id, so an admin
    // of one TMC could clear another tenant's routing by guessing an id.
    const [atClient] = await employees.idsInClientAmong(db, clientId, [employeeId])

    if (!atClient) {
      return Response.json({ error: 'Employee not found at this client' }, { status: 404 })
    }

    await approvals.clearEmployees(db, [employeeId], category)
    return Response.json({ ok: true })
  }

  await approvals.clearDefault(db, clientId, category)
  return Response.json({ ok: true })
})
