import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { getTemplateBandRanks } from '@/app/lib/approval-engine/linkedApprovalTemplates'
import { MODES, QUORUMS, normaliseBandRanks, validateTiers } from '../route'
import { NextRequest } from 'next/server'

// ── PATCH /api/tmc/approval-templates/[id] ───────────────────────────────────
// Edits a template's identity, its tiers, its mode, or the band ranks it
// covers.
//
// Switching mode re-validates the tiers, because the two modes have different
// rules: sequential needs distinct tier numbers, parallel needs at least two
// approvers. Flipping the toggle on a chain the other mode can't express
// should fail with that reason rather than saving something the engine will
// interpret differently than intended.
//
// Rank edits apply as a diff (insert added, delete removed) rather than
// delete-all-then-reinsert, so an unchanged rank never momentarily disappears
// and leaves bookings resolving to no template mid-edit.
//
// ── DELETE /api/tmc/approval-templates/[id] ──────────────────────────────────
// Blocked while any company is still linked.
// ─────────────────────────────────────────────────────────────────────────────

interface UpdateTemplateBody {
  name?: string
  code?: string | null
  description?: string | null
  mode?: string
  quorum?: string
  tiers?: {
    tier: number
    approver_type: string
    min_verdict: string
    approver_user_id?: string | null
    min_band_rank?: number | null
  }[]
  bandRanks?: number[]
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: template } = await service
    .from('approval_chain_templates')
    .select('id, tmc_id, name, mode, quorum, tiers, version')
    .eq('id', id)
    .maybeSingle()

  if (!template) {
    return Response.json({ error: 'Approval template not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_approvals')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== template.tmc_id) {
    return Response.json({ error: 'This template belongs to a different TMC' }, { status: 403 })
  }

  const body: UpdateTemplateBody = await req.json()

  const fields: Record<string, unknown> = {}

  if (body.name !== undefined) {
    if (!body.name.trim()) return Response.json({ error: 'name cannot be empty' }, { status: 400 })
    fields.name = body.name.trim()
  }
  if (body.code !== undefined) fields.code = body.code?.trim() || null
  if (body.description !== undefined) fields.description = body.description?.trim() || null

  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode as typeof MODES[number])) {
      return Response.json({ error: `Invalid mode: ${body.mode}` }, { status: 400 })
    }
    fields.mode = body.mode
  }

  if (body.quorum !== undefined) {
    if (!QUORUMS.includes(body.quorum as typeof QUORUMS[number])) {
      return Response.json({ error: `Invalid quorum: ${body.quorum}` }, { status: 400 })
    }
    fields.quorum = body.quorum
  }

  // Validate whichever tiers will be stored against whichever mode will apply,
  // not just the pair that happened to arrive in this request.
  const effectiveMode = (fields.mode as string) ?? template.mode
  const effectiveTiers = body.tiers ?? (template.tiers as UpdateTemplateBody['tiers']) ?? []

  if (body.tiers !== undefined || body.mode !== undefined) {
    const tierError = validateTiers(effectiveTiers, effectiveMode)
    if (tierError) {
      return Response.json({ error: tierError }, { status: 400 })
    }
    if (body.tiers !== undefined) fields.tiers = body.tiers
  }

  if (Object.keys(fields).length > 0) {
    const { data: caller } = await service
      .from('employees')
      .select('id')
      .eq('id', user.id)
      .maybeSingle()

    fields.version = template.version + 1
    fields.updated_by = caller?.id ?? null

    const { error: updateError } = await service
      .from('approval_chain_templates')
      .update(fields)
      .eq('id', id)

    if (updateError) {
      if (updateError.code === '23505') {
        return Response.json({
          error: `Another template already uses that ${updateError.message.includes('code') ? 'code' : 'name'}`,
        }, { status: 409 })
      }
      return Response.json({ error: updateError.message }, { status: 500 })
    }
  }

  if (body.bandRanks !== undefined) {
    const desired = normaliseBandRanks(body.bandRanks)
    const current = (await getTemplateBandRanks(service, [id])).get(id) ?? []

    const toAdd = desired.filter(r => !current.includes(r))
    const toRemove = current.filter(r => !desired.includes(r))

    if (toRemove.length > 0) {
      const { error: removeError } = await service
        .from('approval_template_band_ranks')
        .delete()
        .eq('template_id', id)
        .in('band_rank', toRemove)

      if (removeError) {
        return Response.json({ error: removeError.message }, { status: 500 })
      }
    }

    if (toAdd.length > 0) {
      const { error: addError } = await service
        .from('approval_template_band_ranks')
        .insert(toAdd.map(band_rank => ({ template_id: id, band_rank })))

      if (addError) {
        // 23P01 comes from approval_template_band_ranks_no_overlap: another
        // template already covers this rank in the same category at a company
        // using this one.
        if (addError.code === '23P01') {
          return Response.json({ error: addError.message }, { status: 409 })
        }
        return Response.json({ error: addError.message }, { status: 500 })
      }
    }
  }

  const bandRanks = (await getTemplateBandRanks(service, [id])).get(id) ?? []

  const { data: updated } = await service
    .from('approval_chain_templates')
    .select('id, name, code, description, category, mode, quorum, tiers, version, created_at')
    .eq('id', id)
    .single()

  return Response.json({ ok: true, template: { ...updated, bandRanks } })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: template } = await service
    .from('approval_chain_templates')
    .select('id, tmc_id, name')
    .eq('id', id)
    .maybeSingle()

  if (!template) {
    return Response.json({ error: 'Approval template not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_approvals')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== template.tmc_id) {
    return Response.json({ error: 'This template belongs to a different TMC' }, { status: 403 })
  }

  const { count } = await service
    .from('company_approval_templates')
    .select('company_id', { count: 'exact', head: true })
    .eq('template_id', id)

  if (count && count > 0) {
    return Response.json({
      error: `${count} compan${count > 1 ? 'ies are' : 'y is'} still using "${template.name}". Unlink them before deleting.`,
    }, { status: 409 })
  }

  // approvals.chain_template_id is ON DELETE SET NULL, so historical approval
  // records survive with their decision intact — they just lose the pointer to
  // a template that no longer exists.
  const { error } = await service.from('approval_chain_templates').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
