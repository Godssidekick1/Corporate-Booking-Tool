import { createClient } from '@/utils/supabase/server'
import { authoriseClient } from '../traveler-profiles/route'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/cost-centres ────────────────────────────────────────────────────
// A client's cost centres, with how many people sit in each.
//
//   GET    ?clientId=              list, with headcount
//   POST                            add one
//   PATCH                           rename, or change the code
//   DELETE ?clientId=&code=        remove, if nobody is on it
//
// employees.cost_centre stores the code as text rather than a foreign key, so
// renaming a code has to carry the employees with it — done here in the same
// transaction, since leaving them pointing at a code that no longer exists is
// how a cost centre quietly stops matching anything in a report.
// ─────────────────────────────────────────────────────────────────────────────

interface CentreBody {
  clientId: string
  code: string
  name?: string
  // PATCH only: the code being renamed, when the code itself changes.
  previousCode?: string
}

const duplicate = (code: string) =>
  Response.json({ error: `"${code}" already exists for this client` }, { status: 409 })

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

  const [centres, people] = await Promise.all([
    clients.costCentresWithDates(db, clientId),
    employees.costCentreUsage(db, clientId),
  ])

  const headcount = new Map<string, number>()
  for (const e of people) {
    if (!e.cost_centre) continue
    headcount.set(e.cost_centre, (headcount.get(e.cost_centre) ?? 0) + 1)
  }

  // Departments are still free text on the employee. Surfaced as the distinct
  // set actually in use so the profile screen can offer them for picking
  // instead of everyone retyping "Engineering" slightly differently.
  const departments = Array.from(
    new Set(people.map(e => e.department?.trim()).filter((d): d is string => Boolean(d)))
  ).sort()

  return Response.json({
    ok: true,
    costCentres: centres.map(c => ({ ...c, employees: headcount.get(c.code) ?? 0 })),
    departments,
    // People on a cost centre that isn't in the list — from a CSV import that
    // predates it, or data loaded before this screen existed.
    unlisted: Array.from(headcount.keys())
      .filter(code => !centres.some(c => c.code === code))
      .map(code => ({ code, employees: headcount.get(code) ?? 0 })),
  })
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: CentreBody = await req.json()
  const { clientId } = body
  const code = body.code?.trim()
  const name = body.name?.trim()

  if (!clientId || !code) {
    return Response.json({ error: 'clientId and code are required' }, { status: 400 })
  }

  const access = await authoriseClient(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  try {
    const centre = await clients.insertCostCentre(db, { client_id: clientId, code, name: name || code })
    return Response.json({ ok: true, costCentre: { ...centre, employees: 0 } }, { status: 201 })
  } catch (err) {
    if (isConstraint(err, 'unique')) return duplicate(code)
    throw err
  }
})

export const PATCH = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: CentreBody = await req.json()
  const { clientId, previousCode } = body
  const code = body.code?.trim()
  const name = body.name?.trim()

  if (!clientId || !code || !previousCode) {
    return Response.json(
      { error: 'clientId, code and previousCode are required' },
      { status: 400 }
    )
  }

  const access = await authoriseClient(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  try {
    // Rename, then carry the employees across, as one unit: a rejected rename
    // (a duplicate code) leaves everyone where they were, and a failure moving
    // them cannot leave the centre renamed with nobody on it.
    //
    // The people move even when previousCode has no cost_centres row -- that
    // is how an "unlisted" code in use is renamed.
    const moved = await transaction(async tx => {
      await clients.renameCostCentre(tx, clientId, previousCode, { code, name: name || code })
      return code !== previousCode ? employees.moveCostCentre(tx, clientId, previousCode, code) : 0
    }, { tenantId: access.tmcId, userId: user.id })

    return Response.json({ ok: true, moved })
  } catch (err) {
    if (isConstraint(err, 'unique')) return duplicate(code)
    throw err
  }
})

export const DELETE = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  const code = req.nextUrl.searchParams.get('code')

  if (!clientId || !code) {
    return Response.json({ error: 'clientId and code are required' }, { status: 400 })
  }

  const access = await authoriseClient(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Blocked rather than cascading: clearing the field on everyone silently
  // would lose which cost centre they were on, and there is no undo.
  const count = await employees.countOnCostCentre(db, clientId, code)

  if (count > 0) {
    return Response.json({
      error: `${count} employee${count > 1 ? 's are' : ' is'} on "${code}". Move them to another cost centre first.`,
    }, { status: 409 })
  }

  await clients.deleteCostCentre(db, clientId, code)

  return Response.json({ ok: true })
})
