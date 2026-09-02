import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { MODES, QUORUMS, validateTiers } from '../route'
import { NextRequest } from 'next/server'

// ── PATCH /api/tmc/approval-templates/[id] ───────────────────────────────────
// Edits a chain's name, its steps, or its mode. Not its approvers — those are
// bound per client in approval_tier_approvers, since a shared template cannot
// name a person who only exists at one client.
//
// Switching mode re-validates the steps, because the modes have different
// rules: sequential needs distinct step numbers, parallel needs at least two.
// Flipping the toggle on a chain the other mode can't express should fail with
// that reason rather than saving something the engine reads differently than
// intended.
//
// ── DELETE /api/tmc/approval-templates/[id] ──────────────────────────────────
// Blocked while any employee is routed through it, or while it is a client's
// default.
// ─────────────────────────────────────────────────────────────────────────────

interface UpdateTemplateBody {
  name?: string
  code?: string | null
  description?: string | null
  mode?: string
  quorum?: string
  // Structure only. Who fills each step is bound per client, in
  // approval_tier_approvers.
  tiers?: {
    tier: number
    min_verdict: string
    label?: string | null
  }[]
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

  if (Object.keys(fields).length === 0) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  fields.version = template.version + 1
  fields.updated_by = caller?.id ?? null

  const { data: updated, error: updateError } = await service
    .from('approval_chain_templates')
    .update(fields)
    .eq('id', id)
    .select('id, name, code, description, category, mode, quorum, tiers, version, created_at, client_id')
    .single()

  if (updateError) {
    if (updateError.code === '23505') {
      return Response.json({
        error: `Another template already uses that ${updateError.message.includes('code') ? 'code' : 'name'}`,
      }, { status: 409 })
    }
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true, template: updated })
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

  const { count: assignedCount } = await service
    .from('employee_approval_templates')
    .select('employee_id', { count: 'exact', head: true })
    .eq('template_id', id)

  if (assignedCount && assignedCount > 0) {
    return Response.json({
      error: `${assignedCount} employee${assignedCount > 1 ? 's are' : ' is'} routed through "${template.name}". Reassign them before deleting.`,
    }, { status: 409 })
  }

  const { count: defaultCount } = await service
    .from('client_default_approval_templates')
    .select('client_id', { count: 'exact', head: true })
    .eq('template_id', id)

  if (defaultCount && defaultCount > 0) {
    return Response.json({
      error: `"${template.name}" is the default for ${defaultCount} client${defaultCount > 1 ? 's' : ''}. Change their default before deleting.`,
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
