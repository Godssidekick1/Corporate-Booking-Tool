import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/approval-templates?search=<text> ────────────────────────────
// Lists the caller's TMC's approval templates. A template is the reusable
// SHAPE of a chain — its approvers, its mode, its verdict thresholds. Who it
// applies to is decided separately, per employee, via
// /api/tmc/approval-assignments.
//
// ── POST /api/tmc/approval-templates ─────────────────────────────────────────
// Creates a template. `mode` is a single enum rather than two flags, so
// sequential (multi-tier) and parallel (multiple approvers) can never both be
// on for the same template.
// ─────────────────────────────────────────────────────────────────────────────

// Approver types deliberately do not live here any more — they belong to a
// binding, not a template. See app/api/tmc/approval-tier-approvers/route.ts.
export const VERDICTS = ['green', 'amber', 'red'] as const
export const CATEGORIES = ['flights_hotels', 'misc'] as const
export const MODES = ['sequential', 'parallel'] as const
export const QUORUMS = ['any', 'all'] as const

// A step, as a template stores it. Structure only — who fills it is bound per
// client in approval_tier_approvers, because a template is shared across
// clients and a person exists in only one of them.
interface TemplateTierInput {
  tier: number
  min_verdict: string
  label?: string | null
}

interface CreateTemplateBody {
  name: string
  code?: string
  description?: string
  category: string
  mode?: string
  quorum?: string
  tiers?: TemplateTierInput[]
  // Set to scope this chain to one client (what the direct-mapping flow
  // produces). Omit for a chain shared across the TMC's clients.
  clientId?: string | null
}

// ── validateTiers ────────────────────────────────────────────────────────────
// Structure only. Approver checks used to live here and no longer can: the
// approver isn't part of the template.
//
// Sequential chains need distinct step numbers, since the engine walks them in
// order. Parallel chains don't: every step is raised at once and the engine
// normalises them onto a single number, so duplicates are meaningless rather
// than wrong. Validating both modes the same way would reject perfectly valid
// parallel setups.
// ─────────────────────────────────────────────────────────────────────────────
export function validateTiers(tiers: TemplateTierInput[], mode: string): string | null {
  if (!Array.isArray(tiers)) return 'tiers must be an array'
  if (tiers.length === 0) return 'A chain needs at least one step'

  const seenTierNumbers = new Set<number>()

  for (const t of tiers) {
    if (!Number.isInteger(t.tier) || t.tier < 1) return `Invalid step number: ${t.tier}`

    if (mode === 'sequential') {
      if (seenTierNumbers.has(t.tier)) return `Duplicate step number: ${t.tier}`
      seenTierNumbers.add(t.tier)
    }

    if (!VERDICTS.includes(t.min_verdict as typeof VERDICTS[number])) {
      return `Invalid min_verdict: ${t.min_verdict}`
    }
  }

  // A parallel group of one is a sequential chain of one, written confusingly.
  if (mode === 'parallel' && tiers.length < 2) {
    return 'Parallel mode needs at least two steps — use multi-tier for a single approver'
  }

  return null
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_approvals')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const search = req.nextUrl.searchParams.get('search')?.trim()

  let query = service
    .from('approval_chain_templates')
    .select('id, name, code, description, category, mode, quorum, tiers, version, created_at, client_id')
    .eq('tmc_id', auth.tmcId)
    .order('name')

  if (search) {
    query = query.or(`name.ilike.%${search}%,code.ilike.%${search}%`)
  }

  const { data: templates, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const templateIds = (templates ?? []).map(t => t.id)

  // How many employees are routed through each template, so an admin can see
  // the blast radius before editing something shared. Counted across the whole
  // TMC: templateIds is already TMC-scoped, and an assignment is only ever
  // created for an employee at a client in that TMC.
  const usageByTemplate = new Map<string, number>()
  const defaultForByTemplate = new Map<string, number>()

  if (templateIds.length > 0) {
    const { data: assignments } = await service
      .from('employee_approval_templates')
      .select('template_id')
      .in('template_id', templateIds)

    for (const a of assignments ?? []) {
      usageByTemplate.set(a.template_id, (usageByTemplate.get(a.template_id) ?? 0) + 1)
    }

    const { data: defaults } = await service
      .from('client_default_approval_templates')
      .select('template_id')
      .in('template_id', templateIds)

    for (const d of defaults ?? []) {
      defaultForByTemplate.set(d.template_id, (defaultForByTemplate.get(d.template_id) ?? 0) + 1)
    }
  }

  return Response.json({
    ok: true,
    templates: (templates ?? []).map(t => ({
      ...t,
      employeeCount: usageByTemplate.get(t.id) ?? 0,
      defaultForClients: defaultForByTemplate.get(t.id) ?? 0,
    })),
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_approvals')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: CreateTemplateBody = await req.json()
  const { name, code, description, category } = body
  const mode = body.mode ?? 'sequential'
  const quorum = body.quorum ?? 'all'
  const tiers = body.tiers ?? []

  if (!name?.trim()) {
    return Response.json({ error: 'name is required' }, { status: 400 })
  }
  if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) {
    return Response.json({ error: `Invalid category: ${category}` }, { status: 400 })
  }
  if (!MODES.includes(mode as typeof MODES[number])) {
    return Response.json({ error: `Invalid mode: ${mode}` }, { status: 400 })
  }
  if (!QUORUMS.includes(quorum as typeof QUORUMS[number])) {
    return Response.json({ error: `Invalid quorum: ${quorum}` }, { status: 400 })
  }

  const tierError = validateTiers(tiers, mode)
  if (tierError) {
    return Response.json({ error: tierError }, { status: 400 })
  }

  // A client-scoped chain must point at a client this TMC actually manages,
  // or it would be created and then be invisible and unusable.
  if (body.clientId) {
    const { data: client } = await service
      .from('clients')
      .select('id, tmc_id')
      .eq('id', body.clientId)
      .maybeSingle()

    if (!client || client.tmc_id !== auth.tmcId) {
      return Response.json({ error: 'Client not found for this TMC' }, { status: 404 })
    }
  }

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  const { data: template, error } = await service
    .from('approval_chain_templates')
    .insert({
      tmc_id: auth.tmcId,
      client_id: body.clientId ?? null,
      name: name.trim(),
      code: code?.trim() || null,
      description: description?.trim() || null,
      category,
      mode,
      quorum,
      tiers,
      updated_by: caller?.id ?? null,
    })
    .select('id, name, code, description, category, mode, quorum, tiers, version, created_at, client_id')
    .single()

  if (error) {
    if (error.code === '23505') {
      const clashedOnCode = code?.trim() && error.message.includes('code')
      return Response.json({
        error: clashedOnCode
          ? `An approval template with code "${code!.trim()}" already exists`
          : `An approval template named "${name.trim()}" already exists`,
      }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json(
    { ok: true, template: { ...template, employeeCount: 0, defaultForClients: 0 } },
    { status: 201 }
  )
}
