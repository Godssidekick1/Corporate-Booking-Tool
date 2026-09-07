import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { fopStatus, describeFop } from '@/app/lib/fop/fopStatus'
import { FOP_COLUMNS, validateFop } from '../route'
import { NextRequest } from 'next/server'

// ── /api/tmc/forms-of-payment/[id] ───────────────────────────────────────────
// GET     one, with its assignments resolved to names
// PATCH   edit it
// DELETE  refused while anything is assigned to it
//
// TMC-side only, unlike the collection GET: a corporate admin may SEE their own
// cards but does not edit the rules deciding when they apply.
// ─────────────────────────────────────────────────────────────────────────────

async function authorise(userId: string, id: string) {
  const service = createServiceClient()
  const auth = await requireTmcPermission(service, userId, 'manage_fops')

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, service, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const { data: fop } = await service
    .from('forms_of_payment')
    .select('id, tmc_id, label')
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!fop) {
    return { ok: false as const, service, error: 'Form of payment not found', status: 404 }
  }

  return { ok: true as const, service, tmcId: auth.tmcId, fop }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { service } = check

  const [{ data: fop }, { data: assignments }] = await Promise.all([
    service.from('forms_of_payment').select(FOP_COLUMNS).eq('id', id).single(),
    service
      .from('fop_assignments')
      .select('id, kind, client_id, client_group_id, bucket_id')
      .eq('fop_id', id),
  ])

  const clientIds = (assignments ?? []).map(a => a.client_id).filter(Boolean) as string[]
  const groupIds = (assignments ?? []).map(a => a.client_group_id).filter(Boolean) as string[]
  const bucketIds = (assignments ?? []).map(a => a.bucket_id).filter(Boolean) as string[]

  const [{ data: clients }, { data: groups }, { data: buckets }] = await Promise.all([
    clientIds.length ? service.from('clients').select('id, name').in('id', clientIds) : Promise.resolve({ data: [] }),
    groupIds.length ? service.from('client_groups').select('id, name').in('id', groupIds) : Promise.resolve({ data: [] }),
    bucketIds.length ? service.from('buckets').select('id, name').in('id', bucketIds) : Promise.resolve({ data: [] }),
  ])

  const nameOf = new Map<string, string>([
    ...(clients ?? []).map(c => [c.id, c.name] as [string, string]),
    ...(groups ?? []).map(g => [g.id, g.name] as [string, string]),
    ...(buckets ?? []).map(b => [b.id, b.name] as [string, string]),
  ])

  return Response.json({
    ok: true,
    fop: { ...fop, status: fopStatus(fop!), description: describeFop(fop!) },
    assignments: (assignments ?? []).map(a => {
      const targetId = a.client_id ?? a.client_group_id ?? a.bucket_id!
      return { id: a.id, kind: a.kind, targetId, targetName: nameOf.get(targetId) ?? 'Unknown' }
    }),
  })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { service, tmcId } = check
  const body = await req.json()

  // Validate against what will END UP stored, not just the fields that arrived.
  // Switching a card to cash without clearing the card fields, or changing the
  // payer without moving the owner, both pass a fields-present check and fail
  // the DB constraint.
  const { data: current } = await service
    .from('forms_of_payment')
    .select('fop_type, payer, card_type, last4, expiry_month, expiry_year, owner_client_id, owner_employee_id, rbd_spec, airline_code')
    .eq('id', id)
    .single()

  const merged = { ...current, ...body }

  // Switching to cash clears the card fields rather than refusing: the user's
  // intent is unambiguous, and making them empty three boxes first is friction
  // for no safety.
  if (merged.fop_type === 'cash') {
    merged.card_type = null
    merged.last4 = null
    merged.expiry_month = null
    merged.expiry_year = null
  }

  // Same for the payer: an agency card has no owner by definition.
  if (merged.payer === 'agency') {
    merged.owner_client_id = null
    merged.owner_employee_id = null
  } else if (merged.payer === 'corporate') {
    merged.owner_employee_id = null
  } else if (merged.payer === 'traveller') {
    merged.owner_client_id = null
  }

  const validationError = validateFop(merged)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  if (merged.branch_id) {
    const { data: branch } = await service
      .from('branches').select('id').eq('id', merged.branch_id).eq('tmc_id', tmcId).maybeSingle()
    if (!branch) {
      return Response.json({ error: 'That branch does not belong to your TMC' }, { status: 422 })
    }
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const editable = [
    'label', 'fop_type', 'payer', 'card_type', 'last4', 'expiry_month', 'expiry_year',
    'gds_alias', 'branch_id', 'owner_client_id', 'owner_employee_id',
    'airline_code', 'rbd_spec', 'active', 'notes',
  ] as const

  for (const field of editable) {
    if (field in body || merged[field] !== current?.[field as keyof typeof current]) {
      update[field] = merged[field] ?? null
    }
  }

  if (typeof update.label === 'string') update.label = update.label.trim()
  if (typeof update.airline_code === 'string') update.airline_code = update.airline_code.trim().toUpperCase() || null
  if (typeof update.rbd_spec === 'string') update.rbd_spec = update.rbd_spec.trim().toUpperCase() || null

  const { data: updated, error } = await service
    .from('forms_of_payment')
    .update(update)
    .eq('id', id)
    .select(FOP_COLUMNS)
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({
    ok: true,
    fop: { ...updated, status: fopStatus(updated), description: describeFop(updated) },
  })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { service, fop } = check

  // The FK cascades, so deleting would silently remove every assignment with it
  // and change how bookings settle for whoever was on it. Refused instead —
  // same rule as buckets and deal codes.
  const { count } = await service
    .from('fop_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('fop_id', id)

  if (count && count > 0) {
    return Response.json(
      {
        error: `"${fop.label}" is assigned to ${count} target${count > 1 ? 's' : ''}. Remove the assignments first, or set it inactive to stop it applying.`,
      },
      { status: 409 }
    )
  }

  const { error } = await service.from('forms_of_payment').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
