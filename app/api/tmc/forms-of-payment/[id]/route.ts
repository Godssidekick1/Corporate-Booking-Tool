import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { fopStatus, describeFop } from '@/app/lib/fop/fopStatus'
import { validateFop, normaliseFop, deriveFopType, checkReferences, FOP_CODE_TAKEN } from '../route'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
import * as fops from '@/app/lib/repositories/fop'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/forms-of-payment/[id] ───────────────────────────────────────────
// GET     one, with its assignments resolved to names
// PATCH   edit it
// DELETE  refused while anything is assigned to it
//
// TMC-side only, unlike the collection GET: a corporate admin may SEE their own
// cards but does not edit the rules deciding when they apply.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> }

async function authorise(userId: string, id: string) {
  const auth = await requireTmcPermission(db, userId, 'manage_fops')

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const fop = await fops.fopInTmc(db, id, auth.tmcId)

  if (!fop) {
    return { ok: false as const, error: 'Form of payment not found', status: 404 }
  }

  return { ok: true as const, tmcId: auth.tmcId, fop }
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

  // is_active comes with each mapping: the editor renders a checkbox bound to
  // it. Target names are joined in rather than looked up per table.
  const [fop, assignments] = await Promise.all([
    fops.fop(db, id),
    fops.namedAssignments(db, id),
  ])

  return Response.json({
    ok: true,
    fop: { ...fop, status: fopStatus(fop!), description: describeFop(fop!) },
    assignments,
  })
})

const EDITABLE = [
  'fop_code', 'label', 'gds_entry_id', 'payment_type_id',
  'fop_type', 'payer', 'card_type', 'last4', 'expiry_month', 'expiry_year',
  'gds_alias', 'branch_id', 'owner_client_id', 'owner_employee_id',
  'airline_code', 'rbd_spec', 'active', 'is_default', 'notes',
] as const

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

  const { tmcId } = check
  const body = await req.json()

  // Validate against what will END UP stored, not just the fields that arrived.
  // Switching a card to cash without clearing the card fields, or changing the
  // payer without moving the owner, both pass a fields-present check and fail
  // the DB constraint.
  const current = (await fops.fop(db, id))!

  // Normalised through the shared helpers rather than a copy of the same rules,
  // which is how POST and PATCH drifted apart in the first place.
  const derived = await deriveFopType(tmcId, { ...current, ...body })
  if ('error' in derived) {
    return Response.json({ error: derived.error }, { status: derived.status })
  }

  const merged = normaliseFop(derived.body)

  const validationError = validateFop(merged)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  // The same tenancy checks as create: branch, owner client AND owner
  // traveller.
  const foreign = await checkReferences(tmcId, merged)
  if (foreign) {
    return Response.json({ error: foreign }, { status: 422 })
  }

  // What was sent, plus whatever normalising changed (a cleared card field).
  const update: Record<string, unknown> = {}
  for (const field of EDITABLE) {
    if (field in body || merged[field] !== current[field]) {
      update[field] = merged[field] ?? null
    }
  }

  if (typeof update.label === 'string') update.label = update.label.trim()
  if (typeof update.fop_code === 'string') update.fop_code = update.fop_code.trim().toUpperCase() || null
  if (typeof update.airline_code === 'string') update.airline_code = update.airline_code.trim().toUpperCase() || null
  if (typeof update.rbd_spec === 'string') update.rbd_spec = update.rbd_spec.trim().toUpperCase() || null

  // Ticking default on a second form of payment is a swap, not a conflict —
  // the previous holder is cleared in the same transaction, so the partial
  // unique index never has to reject the write. Skips this row, so a save that
  // leaves the flag alone does not clear and re-set it.
  try {
    const updated = await transaction(async (tx) => {
      if (update.is_default === true) await fops.clearDefault(tx, tmcId, id)
      return fops.updateFop(tx, id, update as fops.FopEdit)
    }, { tenantId: tmcId, userId: user.id })

    return Response.json({
      ok: true,
      fop: { ...updated, status: fopStatus(updated), description: describeFop(updated) },
    })
  } catch (err) {
    if (isConstraint(err, 'unique', FOP_CODE_TAKEN)) {
      return Response.json(
        { error: `Another form of payment already uses the code "${update.fop_code}"` },
        { status: 409 }
      )
    }
    throw err
  }
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

  // The FK cascades, so deleting would silently remove every assignment with it
  // and change how bookings settle for whoever was on it. Refused instead —
  // same rule as buckets and deal codes.
  const count = await fops.countForFop(db, id)

  if (count > 0) {
    return Response.json(
      {
        error: `"${check.fop.label}" is assigned to ${count} target${count > 1 ? 's' : ''}. Remove the assignments first, or set it inactive to stop it applying.`,
      },
      { status: 409 }
    )
  }

  await fops.deleteFop(db, id)

  return Response.json({ ok: true })
})
