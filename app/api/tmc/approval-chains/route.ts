import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/approval-chains?companyId=<uuid> ─────────────────────────
// Returns every employee for the company, each with whatever chains (if
// any) are currently assigned per category. Unlike policy_rules, chains
// aren't versioned as an append-only history in the UI sense — POSTing an
// update here overwrites the existing row for that (employee, category)
// via upsert, bumping `version` for traceability but not keeping old
// versions queryable. Approval routing correctness matters more than
// historical audit trail here; if that changes, revisit to match
// policy_rules' append-only pattern instead.
//
// ── POST /api/tmc/approval-chains ─────────────────────────────────────────
// Upserts one chain (employee_id, category, tiers). company_id/tmc_id are
// still required on the row itself (approval_chains_scope_check), derived
// server-side from the employee rather than trusted from the request body.
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalCategory = 'flights_hotels' | 'misc'

interface ChainTierInput {
  tier: number
  approver_type: 'manager' | 'finance_role' | 'specific_user' | 'admin' | 'self' | 'any_manager_at'
  min_verdict: 'green' | 'amber' | 'red'
  approver_user_id?: string | null
  min_band_rank?: number | null
}

interface SaveChainBody {
  companyId: string
  employeeId: string
  category: ApprovalCategory
  tiers: ChainTierInput[]
}

const APPROVER_TYPES = ['manager', 'finance_role', 'specific_user', 'admin', 'self', 'any_manager_at']
const VERDICTS = ['green', 'amber', 'red']
const CATEGORIES = ['flights_hotels', 'misc']

function validateTiers(tiers: ChainTierInput[]): string | null {
  if (!Array.isArray(tiers)) return 'tiers must be an array'
  const seenTierNumbers = new Set<number>()

  for (const t of tiers) {
    if (!Number.isInteger(t.tier) || t.tier < 1) return `Invalid tier number: ${t.tier}`
    if (seenTierNumbers.has(t.tier)) return `Duplicate tier number: ${t.tier}`
    seenTierNumbers.add(t.tier)

    if (!APPROVER_TYPES.includes(t.approver_type)) return `Invalid approver_type: ${t.approver_type}`
    if (!VERDICTS.includes(t.min_verdict)) return `Invalid min_verdict: ${t.min_verdict}`
    if (t.approver_type === 'specific_user' && !t.approver_user_id) {
      return `Tier ${t.tier}: specific_user requires approver_user_id`
    }
    if (t.approver_type === 'any_manager_at' && (t.min_band_rank === undefined || t.min_band_rank === null)) {
      return `Tier ${t.tier}: any_manager_at requires min_band_rank`
    }
  }

  return null
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  if (!companyId) {
    return Response.json({ error: 'companyId is required' }, { status: 400 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_approvals', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  // Bands are still fetched — 'any_manager_at' tiers need a rank picker,
  // even though chains themselves no longer key off band.
  const { data: bands, error: bandsError } = await service
    .from('bands')
    .select('id, code, rank')
    .eq('company_id', companyId)
    .order('rank', { ascending: true })

  if (bandsError) {
    return Response.json({ error: bandsError.message }, { status: 500 })
  }

  const { data: employees, error: employeesError } = await service
    .from('employees')
    .select('id, full_name, email, band_code, status')
    .eq('company_id', companyId)
    .order('full_name', { ascending: true })

  if (employeesError) {
    return Response.json({ error: employeesError.message }, { status: 500 })
  }

  const { data: chains, error: chainsError } = await service
    .from('approval_chains')
    .select('id, employee_id, category, tiers, version')
    .eq('company_id', companyId)

  if (chainsError) {
    return Response.json({ error: chainsError.message }, { status: 500 })
  }

  return Response.json({ ok: true, bands: bands ?? [], employees: employees ?? [], chains: chains ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: SaveChainBody = await req.json()
  const { companyId, employeeId, category, tiers } = body

  if (!companyId || !employeeId || !category) {
    return Response.json({ error: 'companyId, employeeId, and category are required' }, { status: 400 })
  }

  if (!CATEGORIES.includes(category)) {
    return Response.json({ error: `Invalid category: ${category}` }, { status: 400 })
  }

  const validationError = validateTiers(tiers ?? [])
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_approvals', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  // Confirm the employee actually belongs to this company before writing —
  // same defensive check as the old bandId check, so a crafted employeeId
  // from a different company can't get a chain attached to this one.
  const { data: employee } = await service
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!employee) {
    return Response.json({ error: 'Employee not found in this company' }, { status: 422 })
  }

  const { data: existing } = await service
    .from('approval_chains')
    .select('id, version')
    .eq('employee_id', employeeId)
    .eq('category', category)
    .maybeSingle()

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (existing) {
    const { error: updateError } = await service
      .from('approval_chains')
      .update({
        tiers,
        version: existing.version + 1,
        updated_by: caller?.id ?? null,
      })
      .eq('id', existing.id)

    if (updateError) {
      return Response.json({ error: updateError.message }, { status: 500 })
    }

    return Response.json({ ok: true, chainId: existing.id, version: existing.version + 1 })
  }

  const { data: created, error: insertError } = await service
    .from('approval_chains')
    .insert({
      company_id: companyId,
      employee_id: employeeId,
      category,
      tiers,
      version: 1,
      updated_by: caller?.id ?? null,
    })
    .select('id')
    .single()

  if (insertError || !created) {
    return Response.json({ error: insertError?.message ?? 'Could not create chain' }, { status: 500 })
  }

  return Response.json({ ok: true, chainId: created.id, version: 1 })
}