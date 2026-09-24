import { createClient } from '@/utils/supabase/server'
import * as approvals from '@/app/lib/repositories/approvals'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { MODES, QUORUMS, validateTiers, NAME_TAKEN, CODE_TAKEN } from '../route'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'

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

export const PATCH = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const template = await approvals.templateRecord(db, id)

  if (!template) {
    return Response.json({ error: 'Approval template not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_approvals')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== template.tmc_id) {
    return Response.json({ error: 'This template belongs to a different TMC' }, { status: 403 })
  }

  const body: UpdateTemplateBody = await req.json()
  const fields: approvals.TemplateEdit = {}

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
  const effectiveMode = fields.mode ?? template.mode
  const effectiveTiers = body.tiers ?? template.tiers ?? []

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

  fields.version = template.version + 1
  fields.updated_by = (await employees.traveller(db, user.id))?.id ?? null

  try {
    const updated = await approvals.updateTemplate(db, id, fields)
    return Response.json({ ok: true, template: updated })
  } catch (err) {
    if (isConstraint(err, 'unique', CODE_TAKEN) || isConstraint(err, 'unique', NAME_TAKEN)) {
      return Response.json({
        error: `Another template already uses that ${err.constraint === CODE_TAKEN ? 'code' : 'name'}`,
      }, { status: 409 })
    }
    throw err
  }
})

export const DELETE = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const template = await approvals.ownership(db, id)

  if (!template) {
    return Response.json({ error: 'Approval template not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_approvals')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== template.tmc_id) {
    return Response.json({ error: 'This template belongs to a different TMC' }, { status: 403 })
  }

  const [employeeCounts, defaultCounts, bandCounts] = await Promise.all([
    approvals.employeeCounts(db, [id]),
    approvals.defaultCounts(db, [id]),
    approvals.bandCounts(db, [id]),
  ])

  const assignedCount = employeeCounts.get(id) ?? 0
  if (assignedCount > 0) {
    return Response.json({
      error: `${assignedCount} employee${assignedCount > 1 ? 's are' : ' is'} routed through "${template.name}". Reassign them before deleting.`,
    }, { status: 409 })
  }

  const defaultCount = defaultCounts.get(id) ?? 0
  if (defaultCount > 0) {
    return Response.json({
      error: `"${template.name}" is the default for ${defaultCount} client${defaultCount > 1 ? 's' : ''}. Change their default before deleting.`,
    }, { status: 409 })
  }

  // Band routing too. band_approval_templates cascades on delete, so without
  // this check deleting a template silently removed every band's routing
  // through it -- the two checks above only ever looked at the other rungs.
  const bandCount = bandCounts.get(id) ?? 0
  if (bandCount > 0) {
    return Response.json({
      error: `"${template.name}" is assigned to ${bandCount} band${bandCount > 1 ? 's' : ''}. Reassign ${bandCount > 1 ? 'them' : 'it'} before deleting.`,
    }, { status: 409 })
  }

  // approvals.chain_template_id is ON DELETE SET NULL, so historical approval
  // records survive with their decision intact — they just lose the pointer to
  // a template that no longer exists.
  await approvals.deleteTemplate(db, id)

  return Response.json({ ok: true })
})
