import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import {
  getAssignmentsForClient,
  getBandAssignmentsForClient,
} from '@/app/lib/approval-engine/linkedApprovalTemplates'
import { APPROVAL_CATEGORIES } from '@/app/lib/approval-engine/resolveApprovalTier'
import { NextRequest } from 'next/server'

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
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  clientId: string
): Promise<{ ok: true; tmcId: string } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(service, userId, 'manage_approvals', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  // tmc_admin passes the permission check for any clientId, so the tenancy
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
  const access = await authorise(service, user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const { data: employees, error } = await service
    .from('employees')
    .select('id, full_name, email, band_code, status')
    .eq('client_id', clientId)
    .order('full_name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const [assignments, bandAssignments] = await Promise.all([
    getAssignmentsForClient(service, (employees ?? []).map(e => e.id)),
    getBandAssignmentsForClient(service, clientId),
  ])

  const [{ data: defaults }, { data: bands }] = await Promise.all([
    service
      .from('client_default_approval_templates')
      .select('category, template_id')
      .eq('client_id', clientId),
    service
      .from('bands')
      .select('code, label, rank')
      .eq('client_id', clientId)
      .order('rank'),
  ])

  return Response.json({
    ok: true,
    employees: (employees ?? []).map(e => ({
      ...e,
      // null here means "inherited" — from their band if that band has an
      // assignment, otherwise from the client default. The UI shows which, so an
      // admin can tell a deliberate choice from something they are getting by
      // virtue of where they sit.
      assignments: Object.fromEntries(
        CATEGORIES.map(c => [c, assignments.get(`${e.id}::${c}`) ?? null])
      ),
    })),
    bands: (bands ?? []).map(b => ({
      ...b,
      assignments: Object.fromEntries(
        CATEGORIES.map(c => [c, bandAssignments.get(`${b.code}::${c}`) ?? null])
      ),
    })),
    defaults: Object.fromEntries(
      CATEGORIES.map(c => [c, (defaults ?? []).find(d => d.category === c)?.template_id ?? null])
    ),
  })
}

export async function POST(req: NextRequest) {
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

  const service = createServiceClient()
  const access = await authorise(service, user.id, clientId)
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
    const { data: template } = await service
      .from('approval_chain_templates')
      .select('id, tmc_id')
      .eq('id', templateId)
      .maybeSingle()

    if (!template || template.tmc_id !== access.tmcId) {
      return Response.json({ error: 'Approval template not found for this TMC' }, { status: 404 })
    }
  }

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  // ── Per-employee assignment (possibly bulk) ────────────────────────────────
  if (Array.isArray(employeeIds) && employeeIds.length > 0) {
    // Confirm every id actually belongs to this client before writing any of
    // them, so a forged id can't attach an assignment to someone else's staff.
    const { data: verified } = await service
      .from('employees')
      .select('id')
      .eq('client_id', clientId)
      .in('id', employeeIds)

    const verifiedIds = (verified ?? []).map(e => e.id)

    if (verifiedIds.length !== employeeIds.length) {
      return Response.json({ error: 'One or more employees do not belong to this client' }, { status: 400 })
    }

    if (templateId === null) {
      const { error: clearError } = await service
        .from('employee_approval_templates')
        .delete()
        .eq('category', category)
        .in('employee_id', verifiedIds)

      if (clearError) {
        return Response.json({ error: clearError.message }, { status: 500 })
      }

      return Response.json({ ok: true, cleared: verifiedIds.length })
    }

    const { error: upsertError } = await service
      .from('employee_approval_templates')
      .upsert(
        verifiedIds.map(employee_id => ({
          employee_id,
          category,
          template_id: templateId,
          assigned_by: caller?.id ?? null,
          assigned_at: new Date().toISOString(),
        })),
        { onConflict: 'employee_id,category' }
      )

    if (upsertError) {
      return Response.json({ error: upsertError.message }, { status: 500 })
    }

    return Response.json({ ok: true, assigned: verifiedIds.length })
  }

  // ── Band assignment ───────────────────────────────────────────────────────
  if (bandCode) {
    // Verified against this client's own bands. band_code is text, and the
    // composite FK to bands only exists where the schema supports it, so an
    // unrecognised code would otherwise be accepted here and then match nobody
    // at resolution time — a routing rule that silently does nothing.
    const { data: band } = await service
      .from('bands')
      .select('code')
      .eq('client_id', clientId)
      .eq('code', bandCode)
      .maybeSingle()

    if (!band) {
      return Response.json({ error: `"${bandCode}" is not a band at this client` }, { status: 400 })
    }

    if (templateId === null) {
      const { error: clearError } = await service
        .from('band_approval_templates')
        .delete()
        .eq('client_id', clientId)
        .eq('band_code', bandCode)
        .eq('category', category)

      if (clearError) {
        return Response.json({ error: clearError.message }, { status: 500 })
      }

      return Response.json({ ok: true, bandCleared: true })
    }

    const { error: bandError } = await service
      .from('band_approval_templates')
      .upsert({
        client_id: clientId,
        band_code: bandCode,
        category,
        template_id: templateId,
        assigned_by: caller?.id ?? null,
        assigned_at: new Date().toISOString(),
      }, { onConflict: 'client_id,band_code,category' })

    if (bandError) {
      return Response.json({ error: bandError.message }, { status: 500 })
    }

    return Response.json({ ok: true, bandSet: true })
  }

  // ── Client default ────────────────────────────────────────────────────────
  if (templateId === null) {
    const { error: clearError } = await service
      .from('client_default_approval_templates')
      .delete()
      .eq('client_id', clientId)
      .eq('category', category)

    if (clearError) {
      return Response.json({ error: clearError.message }, { status: 500 })
    }

    return Response.json({ ok: true, defaultCleared: true })
  }

  const { error: defaultError } = await service
    .from('client_default_approval_templates')
    .upsert({
      client_id: clientId,
      category,
      template_id: templateId,
      assigned_by: caller?.id ?? null,
      assigned_at: new Date().toISOString(),
    }, { onConflict: 'client_id,category' })

  if (defaultError) {
    return Response.json({ error: defaultError.message }, { status: 500 })
  }

  return Response.json({ ok: true, defaultSet: true })
}

export async function DELETE(req: NextRequest) {
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

  const service = createServiceClient()
  const access = await authorise(service, user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  if (bandCode) {
    const { error } = await service
      .from('band_approval_templates')
      .delete()
      .eq('client_id', clientId)
      .eq('band_code', bandCode)
      .eq('category', category)

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }

    return Response.json({ ok: true })
  }

  if (employeeId) {
    const { error } = await service
      .from('employee_approval_templates')
      .delete()
      .eq('employee_id', employeeId)
      .eq('category', category)

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }

    return Response.json({ ok: true })
  }

  const { error } = await service
    .from('client_default_approval_templates')
    .delete()
    .eq('client_id', clientId)
    .eq('category', category)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
