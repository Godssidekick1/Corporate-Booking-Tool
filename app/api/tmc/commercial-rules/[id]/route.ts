import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { commercialStatus } from '@/app/lib/commercials/commercialStatus'
import { describeVia } from '@/app/lib/commercials/resolveCommercials'
import { isCommercialKind, type CommercialKind } from '@/app/lib/commercials/calcOnByKind'
import { RULE_COLUMNS, validateRule, type RuleBody, type CommercialRuleRow } from '../route'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'

// ── /api/tmc/commercial-rules/[id] ───────────────────────────────────────────
// One rule, with the targets it reaches.
// ─────────────────────────────────────────────────────────────────────────────

// Both verbs need the same two answers: may this caller manage commercials, and
// does this rule belong to their TMC.
async function authorise(ruleId: string) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: Response.json({ error: 'Not authenticated' }, { status: 401 }) }
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(db, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return { error: Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 }) }
  }
  const tmcId = auth.tmcId

  const { data: rawRule } = await service
    .from('commercial_rules')
    .select(RULE_COLUMNS)
    .eq('id', ruleId)
    .eq('tmc_id', tmcId)
    .maybeSingle()

  if (!rawRule) {
    return { error: Response.json({ error: 'Rule not found' }, { status: 404 }) }
  }

  // RULE_COLUMNS is a concatenation, so Supabase's inference gives up — see the
  // comment on CommercialRuleRow.
  const rule = rawRule as unknown as CommercialRuleRow

  return { service, tmcId, rule, userId: user.id }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error
  const { service, rule } = auth

  const { data: rows } = await service
    .from('commercial_rule_assignments')
    .select('id, kind, client_id, client_group_id, bucket_id')
    .eq('rule_id', id)

  const assignments = rows ?? []

  // Names for the chips, fetched per target type. Only the ids actually used —
  // no point reading every bucket in the TMC to label two of them.
  const clientIds = assignments.map(a => a.client_id).filter(Boolean) as string[]
  const groupIds = assignments.map(a => a.client_group_id).filter(Boolean) as string[]
  const bucketIds = assignments.map(a => a.bucket_id).filter(Boolean) as string[]

  const [{ data: clients }, { data: groups }, { data: buckets }] = await Promise.all([
    clientIds.length
      ? service.from('clients').select('id, name').in('id', clientIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    groupIds.length
      ? service.from('client_groups').select('id, name').in('id', groupIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    bucketIds.length
      ? service.from('buckets').select('id, name').in('id', bucketIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ])

  const nameOf = new Map<string, string>([
    ...(clients ?? []).map(c => [c.id, c.name] as [string, string]),
    ...(groups ?? []).map(g => [g.id, g.name] as [string, string]),
    ...(buckets ?? []).map(b => [b.id, b.name] as [string, string]),
  ])

  return Response.json({
    ok: true,
    rule: { ...rule, status: commercialStatus(rule) },
    assignments: assignments.map(a => {
      const targetId = a.client_id ?? a.client_group_id ?? a.bucket_id ?? ''
      const targetName = nameOf.get(targetId) ?? 'Unknown'
      return {
        id: a.id,
        kind: a.kind,
        targetId,
        targetName,
        via: describeVia(a.kind, a.kind === 'client' ? null : targetName),
      }
    }),
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error
  const { service, tmcId, rule } = auth

  const body: RuleBody = await req.json()

  // The kind is immutable. A markup edited into a discount would keep its
  // assignments and its id while inverting what it does to every client it
  // reaches — and the fee-only columns would have to be added or nulled to
  // match. Delete and recreate instead; it is one more click and no ambiguity.
  if (body.kind !== undefined && body.kind !== rule.kind) {
    return Response.json({
      error: 'A rule cannot change kind. Delete it and create the new one.',
    }, { status: 400 })
  }

  const kind = rule.kind as CommercialKind
  if (!isCommercialKind(kind)) {
    return Response.json({ error: 'This rule has an unrecognised kind' }, { status: 500 })
  }

  // Validated against the MERGED shape, not the patch alone: a PATCH changing
  // only calc_type from fixed to percent has to be checked against the rate
  // already on the row, or a 5000 flat fee silently becomes 5000%.
  const merged: RuleBody = {
    airline_code: body.airline_code !== undefined ? body.airline_code : rule.airline_code,
    cabin: body.cabin !== undefined ? body.cabin : rule.cabin,
    rbd_spec: body.rbd_spec !== undefined ? body.rbd_spec : rule.rbd_spec,
    fare_type: body.fare_type ?? rule.fare_type,
    calc_type: body.calc_type ?? rule.calc_type,
    calc_on: body.calc_on ?? rule.calc_on,
    rate: body.rate ?? rule.rate,
    calc_basis: body.calc_basis !== undefined ? body.calc_basis : rule.calc_basis,
    exclude_tax_codes: body.exclude_tax_codes !== undefined ? body.exclude_tax_codes : rule.exclude_tax_codes,
    include_ssr: body.include_ssr !== undefined ? body.include_ssr : rule.include_ssr,
    valid_from: body.valid_from !== undefined ? body.valid_from : rule.valid_from,
    valid_to: body.valid_to !== undefined ? body.valid_to : rule.valid_to,
  }

  const validationError = validateRule(kind, merged)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  if (body.category_id && body.category_id !== rule.category_id) {
    const { data: category } = await service
      .from('deal_code_categories')
      .select('id')
      .eq('id', body.category_id)
      .eq('tmc_id', tmcId)
      .maybeSingle()

    if (!category) {
      return Response.json({ error: 'Category not found for this TMC' }, { status: 422 })
    }
  }

  const isFee = kind === 'processing_fee'

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.category_id !== undefined) update.category_id = body.category_id
  if (body.airline_code !== undefined) update.airline_code = body.airline_code?.trim().toUpperCase() || null
  if (body.cabin !== undefined) update.cabin = body.cabin || null
  if (body.rbd_spec !== undefined) update.rbd_spec = body.rbd_spec?.trim() || null
  if (body.fare_type !== undefined) update.fare_type = body.fare_type
  if (body.calc_type !== undefined) update.calc_type = body.calc_type
  if (body.calc_on !== undefined) update.calc_on = body.calc_on
  if (body.rate !== undefined) update.rate = body.rate
  if (body.valid_from !== undefined) update.valid_from = body.valid_from || null
  if (body.valid_to !== undefined) update.valid_to = body.valid_to || null
  if (body.active !== undefined) update.active = body.active
  if (body.notes !== undefined) update.notes = body.notes?.trim() || null

  // Only writable on a fee. Ignored rather than rejected for the other kinds:
  // validateRule has already refused a payload that sets them meaningfully, and
  // an editor sending its whole form should not fail on a field it left empty.
  if (isFee) {
    if (body.calc_basis !== undefined) update.calc_basis = body.calc_basis
    if (body.exclude_tax_codes !== undefined) update.exclude_tax_codes = body.exclude_tax_codes ?? []
    if (body.include_ssr !== undefined) update.include_ssr = body.include_ssr ?? false
  }

  const { data: rawUpdated, error } = await service
    .from('commercial_rules')
    .update(update)
    .eq('id', id)
    // Scoped again, not only by the check above: that read and this write are
    // separate statements, so the tenancy guarantee would otherwise depend on
    // nobody reordering the function.
    .eq('tmc_id', tmcId)
    .select(RULE_COLUMNS)
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const updated = rawUpdated as unknown as CommercialRuleRow
  return Response.json({ ok: true, rule: { ...updated, status: commercialStatus(updated) } })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error
  const { service, tmcId } = auth

  // Assignments cascade. Unlike deleting a bucket — which is refused when
  // anything points at it, because the bucket is a shared THING other rules
  // reach through — a rule's assignments exist only to say who this rule
  // reaches, and they mean nothing without it.
  const { error } = await service
    .from('commercial_rules')
    .delete()
    .eq('id', id)
    .eq('tmc_id', tmcId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
