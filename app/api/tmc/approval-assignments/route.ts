import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { getAssignmentsForCompany } from '@/app/lib/approval-engine/linkedApprovalTemplates'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/approval-assignments?companyId=<uuid> ───────────────────────
// The whole company's approval routing in one payload: every employee with
// their explicit assignment per category, plus the company defaults that cover
// anyone unassigned.
//
// Returned as one roster rather than per-employee so the screen can show who
// routes where at a glance, and support selecting several people at once —
// the previous design needed a company pick, an employee pick and two saves
// for every single person.
//
// ── POST /api/tmc/approval-assignments ───────────────────────────────────────
// Assigns a template. With `employeeIds`, assigns to those employees (any
// number at once). Without, sets the company default for that category.
// Passing a null templateId clears instead.
//
// ── DELETE ?companyId=&category=&employeeId= ─────────────────────────────────
// Clears one employee's assignment, or the company default when employeeId is
// omitted.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = ['flights_hotels', 'misc']

interface AssignBody {
  companyId: string
  category: string
  templateId: string | null
  employeeIds?: string[]
}

async function authorise(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  companyId: string
): Promise<{ ok: true; tmcId: string } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(service, userId, 'manage_approvals', companyId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  // tmc_admin passes the permission check for any companyId, so the tenancy
  // boundary is checked explicitly.
  const { data: company } = await service
    .from('companies')
    .select('id, tmc_id')
    .eq('id', companyId)
    .maybeSingle()

  if (!company || company.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Company not found for this TMC', status: 404 }
  }

  return { ok: true, tmcId: auth.tmcId }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  if (!companyId) {
    return Response.json({ error: 'companyId is required' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authorise(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const { data: employees, error } = await service
    .from('employees')
    .select('id, full_name, email, band_code, status')
    .eq('company_id', companyId)
    .order('full_name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const assignments = await getAssignmentsForCompany(service, (employees ?? []).map(e => e.id))

  const { data: defaults } = await service
    .from('company_default_approval_templates')
    .select('category, template_id')
    .eq('company_id', companyId)

  return Response.json({
    ok: true,
    employees: (employees ?? []).map(e => ({
      ...e,
      // null here means "falls back to the company default" — the UI shows
      // which, so an admin can tell a deliberate choice from an inherited one.
      assignments: Object.fromEntries(
        CATEGORIES.map(c => [c, assignments.get(`${e.id}::${c}`) ?? null])
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
  const { companyId, category, templateId, employeeIds } = body

  if (!companyId || !category) {
    return Response.json({ error: 'companyId and category are required' }, { status: 400 })
  }
  if (!CATEGORIES.includes(category)) {
    return Response.json({ error: `Invalid category: ${category}` }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authorise(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // A template from another TMC would route this company's bookings to
  // approvers who don't work there.
  if (templateId) {
    const { data: template } = await service
      .from('approval_chain_templates')
      .select('id, category, tmc_id')
      .eq('id', templateId)
      .maybeSingle()

    if (!template || template.tmc_id !== access.tmcId) {
      return Response.json({ error: 'Approval template not found for this TMC' }, { status: 404 })
    }

    // Assigning a flights template to the misc category would route bookings
    // through a chain built for a different kind of spend.
    if (template.category !== category) {
      return Response.json({
        error: `That template routes "${template.category}", not "${category}"`,
      }, { status: 400 })
    }
  }

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  // ── Per-employee assignment (possibly bulk) ────────────────────────────────
  if (Array.isArray(employeeIds) && employeeIds.length > 0) {
    // Confirm every id actually belongs to this company before writing any of
    // them, so a forged id can't attach an assignment to someone else's staff.
    const { data: verified } = await service
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .in('id', employeeIds)

    const verifiedIds = (verified ?? []).map(e => e.id)

    if (verifiedIds.length !== employeeIds.length) {
      return Response.json({ error: 'One or more employees do not belong to this company' }, { status: 400 })
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

  // ── Company default ────────────────────────────────────────────────────────
  if (templateId === null) {
    const { error: clearError } = await service
      .from('company_default_approval_templates')
      .delete()
      .eq('company_id', companyId)
      .eq('category', category)

    if (clearError) {
      return Response.json({ error: clearError.message }, { status: 500 })
    }

    return Response.json({ ok: true, defaultCleared: true })
  }

  const { error: defaultError } = await service
    .from('company_default_approval_templates')
    .upsert({
      company_id: companyId,
      category,
      template_id: templateId,
      assigned_by: caller?.id ?? null,
      assigned_at: new Date().toISOString(),
    }, { onConflict: 'company_id,category' })

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

  const companyId = req.nextUrl.searchParams.get('companyId')
  const category = req.nextUrl.searchParams.get('category')
  const employeeId = req.nextUrl.searchParams.get('employeeId')

  if (!companyId || !category) {
    return Response.json({ error: 'companyId and category are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authorise(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
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
    .from('company_default_approval_templates')
    .delete()
    .eq('company_id', companyId)
    .eq('category', category)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
