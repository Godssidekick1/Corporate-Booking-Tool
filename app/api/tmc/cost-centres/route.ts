import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { authoriseCompany } from '../traveler-profiles/route'
import { NextRequest } from 'next/server'

// ── /api/tmc/cost-centres ────────────────────────────────────────────────────
// A client's cost centres, with how many people sit in each.
//
//   GET    ?companyId=              list, with headcount
//   POST                            add one
//   PATCH                           rename, or change the code
//   DELETE ?companyId=&code=        remove, if nobody is on it
//
// employees.cost_centre stores the code as text rather than a foreign key, so
// renaming a code has to carry the employees with it — done here in the same
// request, since leaving them pointing at a code that no longer exists is how
// a cost centre quietly stops matching anything in a report.
// ─────────────────────────────────────────────────────────────────────────────

interface CentreBody {
  companyId: string
  code: string
  name?: string
  // PATCH only: the code being renamed, when the code itself changes.
  previousCode?: string
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
  const access = await authoriseCompany(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const [{ data: centres, error }, { data: employees }] = await Promise.all([
    service
      .from('cost_centres')
      .select('id, code, name, created_at')
      .eq('company_id', companyId)
      .order('code'),
    service
      .from('employees')
      .select('cost_centre, department')
      .eq('company_id', companyId),
  ])

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const headcount = new Map<string, number>()
  for (const e of employees ?? []) {
    if (!e.cost_centre) continue
    headcount.set(e.cost_centre, (headcount.get(e.cost_centre) ?? 0) + 1)
  }

  // Departments are still free text on the employee. Surfaced as the distinct
  // set actually in use so the profile screen can offer them for picking
  // instead of everyone retyping "Engineering" slightly differently.
  const departments = Array.from(
    new Set((employees ?? []).map(e => e.department?.trim()).filter(Boolean) as string[])
  ).sort()

  return Response.json({
    ok: true,
    costCentres: (centres ?? []).map(c => ({ ...c, employees: headcount.get(c.code) ?? 0 })),
    departments,
    // People on a cost centre that isn't in the list — from a CSV import that
    // predates it, or data loaded before this screen existed.
    unlisted: Array.from(headcount.keys())
      .filter(code => !(centres ?? []).some(c => c.code === code))
      .map(code => ({ code, employees: headcount.get(code) ?? 0 })),
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: CentreBody = await req.json()
  const { companyId } = body
  const code = body.code?.trim()
  const name = body.name?.trim()

  if (!companyId || !code) {
    return Response.json({ error: 'companyId and code are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authoriseCompany(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const { data: centre, error } = await service
    .from('cost_centres')
    .insert({ company_id: companyId, code, name: name || code })
    .select('id, code, name, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json({ error: `"${code}" already exists for this client` }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, costCentre: { ...centre, employees: 0 } }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: CentreBody = await req.json()
  const { companyId, previousCode } = body
  const code = body.code?.trim()
  const name = body.name?.trim()

  if (!companyId || !code || !previousCode) {
    return Response.json(
      { error: 'companyId, code and previousCode are required' },
      { status: 400 }
    )
  }

  const service = createServiceClient()
  const access = await authoriseCompany(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const { error } = await service
    .from('cost_centres')
    .update({ code, name: name || code })
    .eq('company_id', companyId)
    .eq('code', previousCode)

  if (error) {
    if (error.code === '23505') {
      return Response.json({ error: `"${code}" already exists for this client` }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Carry the employees across. Done after the rename rather than before so a
  // rejected rename (a duplicate code) leaves everyone where they were.
  let moved = 0
  if (code !== previousCode) {
    const { data: movedRows } = await service
      .from('employees')
      .update({ cost_centre: code })
      .eq('company_id', companyId)
      .eq('cost_centre', previousCode)
      .select('id')

    moved = movedRows?.length ?? 0
  }

  return Response.json({ ok: true, moved })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  const code = req.nextUrl.searchParams.get('code')

  if (!companyId || !code) {
    return Response.json({ error: 'companyId and code are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authoriseCompany(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Blocked rather than cascading: clearing the field on everyone silently
  // would lose which cost centre they were on, and there is no undo.
  const { count } = await service
    .from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('cost_centre', code)

  if (count && count > 0) {
    return Response.json({
      error: `${count} employee${count > 1 ? 's are' : ' is'} on "${code}". Move them to another cost centre first.`,
    }, { status: 409 })
  }

  const { error } = await service
    .from('cost_centres')
    .delete()
    .eq('company_id', companyId)
    .eq('code', code)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
