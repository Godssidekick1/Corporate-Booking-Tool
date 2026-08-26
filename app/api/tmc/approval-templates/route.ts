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

export const APPROVER_TYPES = [
  'manager', 'finance_role', 'specific_user', 'admin', 'self', 'any_manager_at',
] as const
export const VERDICTS = ['green', 'amber', 'red'] as const
export const CATEGORIES = ['flights_hotels', 'misc'] as const
export const MODES = ['sequential', 'parallel'] as const
export const QUORUMS = ['any', 'all'] as const

interface ChainTierInput {
  tier: number
  approver_type: string
  min_verdict: string
  approver_user_id?: string | null
  min_band_rank?: number | null
}

interface CreateTemplateBody {
  name: string
  code?: string
  description?: string
  category: string
  mode?: string
  quorum?: string
  tiers?: ChainTierInput[]
}

// ── validateTiers ────────────────────────────────────────────────────────────
// Sequential chains need distinct tier numbers, since the engine walks them in
// order. Parallel chains don't: every entry is raised at once and the engine
// normalises them onto a single tier number, so duplicates are meaningless
// rather than wrong. Validating both modes the same way would reject perfectly
// valid parallel setups.
// ─────────────────────────────────────────────────────────────────────────────
export function validateTiers(tiers: ChainTierInput[], mode: string): string | null {
  if (!Array.isArray(tiers)) return 'tiers must be an array'
  if (tiers.length === 0) return 'A template needs at least one approver'

  const seenTierNumbers = new Set<number>()

  for (const t of tiers) {
    if (!Number.isInteger(t.tier) || t.tier < 1) return `Invalid tier number: ${t.tier}`

    if (mode === 'sequential') {
      if (seenTierNumbers.has(t.tier)) return `Duplicate tier number: ${t.tier}`
      seenTierNumbers.add(t.tier)
    }

    if (!APPROVER_TYPES.includes(t.approver_type as typeof APPROVER_TYPES[number])) {
      return `Invalid approver_type: ${t.approver_type}`
    }
    if (!VERDICTS.includes(t.min_verdict as typeof VERDICTS[number])) {
      return `Invalid min_verdict: ${t.min_verdict}`
    }
    if (t.approver_type === 'specific_user' && !t.approver_user_id) {
      return `Tier ${t.tier}: specific_user requires a chosen person`
    }
    if (t.approver_type === 'any_manager_at' && (t.min_band_rank === undefined || t.min_band_rank === null)) {
      return `Tier ${t.tier}: any_manager_at requires min_band_rank`
    }
  }

  // A parallel group of one is a sequential chain of one, written confusingly.
  if (mode === 'parallel' && tiers.length < 2) {
    return 'Parallel mode needs at least two approvers — use multi-tier for a single approver'
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
    .select('id, name, code, description, category, mode, quorum, tiers, version, created_at')
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
  // created for an employee at a company in that TMC.
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
      .from('company_default_approval_templates')
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
      defaultForCompanies: defaultForByTemplate.get(t.id) ?? 0,
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

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  const { data: template, error } = await service
    .from('approval_chain_templates')
    .insert({
      tmc_id: auth.tmcId,
      name: name.trim(),
      code: code?.trim() || null,
      description: description?.trim() || null,
      category,
      mode,
      quorum,
      tiers,
      updated_by: caller?.id ?? null,
    })
    .select('id, name, code, description, category, mode, quorum, tiers, version, created_at')
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
    { ok: true, template: { ...template, employeeCount: 0, defaultForCompanies: 0 } },
    { status: 201 }
  )
}
