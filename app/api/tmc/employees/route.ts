import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/employees?companyId=<uuid> ──────────────────────────────────
// Lists a client company's employees with their band, for TMC-side screens
// that need to pick or review one (currently the rule-engine test page).
//
// This replaces the listing half of the old employee-assignments route. The
// assignment half is gone for good: under the Policy Master model an employee's
// policy follows from their band rank and the groups linked to their company,
// so there is nothing per-employee left to assign.
// ─────────────────────────────────────────────────────────────────────────────

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

  // Passing companyId here also enforces per-company access for 'tc' callers,
  // not just the manage_policy permission itself.
  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  // Confirm the company belongs to the caller's TMC — a tmc_admin passes the
  // permission check for any companyId, so the tenancy boundary is checked here.
  const { data: company } = await service
    .from('companies')
    .select('id, tmc_id')
    .eq('id', companyId)
    .maybeSingle()

  if (!company || company.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Company not found for this TMC' }, { status: 404 })
  }

  // manager_id comes back so the hierarchy screen and the approval-step binder
  // can both show, and warn about, an employee with no reporting line — a
  // 'manager' step resolves to nobody without one.
  const { data: employees, error } = await service
    .from('employees')
    .select('id, full_name, email, band_code, band_rank, status, manager_id')
    .eq('company_id', companyId)
    .order('full_name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, employees: employees ?? [] })
}
