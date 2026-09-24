import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { dealCodeStatus } from '@/app/lib/deal-codes/dealCodeStatus'
import { loadCategory, validateDealCode } from '../route'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/deal-codes/[id] ─────────────────────────────────────────────────
// GET     one deal with its assignments resolved to names
// PATCH   edit it
// DELETE  refused while anything is assigned to it
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> }

async function authorise(userId: string, id: string) {
  const auth = await requireTmcPermission(db, userId, 'manage_deal_codes')

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const deal = await dealCodes.dealInTmc(db, id, auth.tmcId)

  if (!deal) {
    return { ok: false as const, error: 'Deal code not found', status: 404 }
  }

  return { ok: true as const, tmcId: auth.tmcId, deal }
}

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  // The target names come back with the assignments in one join -- this used
  // to be the assignments, then a lookup per target table.
  const [deal, assignments] = await Promise.all([
    dealCodes.dealCode(db, id),
    dealCodes.namedAssignments(db, id),
  ])

  return Response.json({
    ok: true,
    dealCode: { ...deal, status: dealCodeStatus(deal!) },
    assignments,
  })
})

interface UpdateBody {
  category_id?: string
  airline_code?: string
  code?: string
  code_type?: string
  flight_spec?: string | null
  sales_from?: string | null
  sales_to?: string | null
  travel_from?: string | null
  travel_to?: string | null
  active?: boolean
  notes?: string | null
}

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const body: UpdateBody = await req.json()

  // Validate against whichever category and airline will END UP stored, not
  // just the fields that happened to arrive. Changing category alone can make
  // an existing code type invalid, and changing airline alone can invalidate an
  // existing flight spec.
  const current = (await dealCodes.editBase(db, id))!

  const category = await loadCategory(check.tmcId, body.category_id ?? current.category_id)
  if (!category) {
    return Response.json({ error: 'Airline category not found for this TMC' }, { status: 404 })
  }

  const validationError = validateDealCode(
    {
      ...body,
      airline_code: body.airline_code ?? current.airline_code,
      code_type: body.code_type ?? current.code_type,
      flight_spec: body.flight_spec !== undefined ? body.flight_spec : current.flight_spec,
    },
    category.allowedTypes,
    category.code
  )
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  // Undefined fields are left as they are.
  const updated = await dealCodes.updateDeal(db, id, {
    category_id: body.category_id,
    airline_code: body.airline_code?.trim().toUpperCase(),
    code: body.code?.trim().toUpperCase(),
    code_type: body.code_type,
    flight_spec: body.flight_spec === undefined ? undefined : body.flight_spec?.trim() || null,
    sales_from: body.sales_from === undefined ? undefined : body.sales_from || null,
    sales_to: body.sales_to === undefined ? undefined : body.sales_to || null,
    travel_from: body.travel_from === undefined ? undefined : body.travel_from || null,
    travel_to: body.travel_to === undefined ? undefined : body.travel_to || null,
    active: body.active,
    notes: body.notes === undefined ? undefined : body.notes?.trim() || null,
  })

  return Response.json({ ok: true, dealCode: { ...updated, status: dealCodeStatus(updated) } })
})

export const DELETE = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  // The FK cascades, so deleting would silently remove every assignment with
  // it. Refused instead: unassigning is a decision someone should make
  // deliberately, and a negotiated code that quietly stops applying to forty
  // clients is not a failure anyone notices until a fare comes back wrong.
  const count = await dealCodes.countForDeal(db, id)

  if (count > 0) {
    return Response.json(
      {
        error: `"${check.deal.code}" is assigned to ${count} target${count > 1 ? 's' : ''}. Remove the assignments before deleting, or set it inactive to stop it applying.`,
      },
      { status: 409 }
    )
  }

  await dealCodes.deleteDeal(db, id)

  return Response.json({ ok: true })
})
