import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── /api/tmc/approval-tier-approvers ─────────────────────────────────────────
// Who fills each step of one approval chain at one client.
//
// A template carries structure only — steps, verdict thresholds, labels — since
// it is shared across clients and a person exists in just one of them. This is
// the other half: identity, bound per client.
//
//   GET    ?clientId=&templateId=   the bindings, plus the template's steps
//   POST                             upsert one step's approver
//   DELETE ?clientId=&templateId=&tier=   clear one step
//
// A step with no binding is unbound, and bookings that reach it raise no
// approval — the engine reports that rather than approving silently, and the
// UI flags it, but nothing here prevents it. Half-configuring a chain has to be
// possible or you could never build one incrementally.
// ─────────────────────────────────────────────────────────────────────────────

const APPROVER_TYPES = [
  'manager', 'any_manager_at', 'finance_role', 'admin', 'self', 'specific_user',
] as const

type ApproverType = typeof APPROVER_TYPES[number]

interface BindBody {
  clientId: string
  templateId: string
  tier: number
  approverType: ApproverType
  approverUserId?: string | null
  minBandRank?: number | null
}

async function authorise(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  clientId: string,
  templateId: string
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(service, userId, 'manage_approvals', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const { data: client } = await service
    .from('clients')
    .select('id, tmc_id')
    .eq('id', clientId)
    .maybeSingle()

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Client not found for this TMC', status: 404 }
  }

  const { data: template } = await service
    .from('approval_chain_templates')
    .select('id, tmc_id, client_id')
    .eq('id', templateId)
    .maybeSingle()

  if (!template || template.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Approval chain not found for this TMC', status: 404 }
  }

  // A client-owned chain belongs to exactly one client. Binding approvers to
  // it from another client would quietly build routing nobody can reach.
  if (template.client_id && template.client_id !== clientId) {
    return { ok: false, error: 'This approval chain belongs to a different client', status: 403 }
  }

  return { ok: true }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  const templateId = req.nextUrl.searchParams.get('templateId')

  if (!clientId || !templateId) {
    return Response.json({ error: 'clientId and templateId are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authorise(service, user.id, clientId, templateId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Steps come back alongside the bindings so the caller renders one list and
  // can tell a bound step from an unbound one without a second request.
  const { data: template } = await service
    .from('approval_chain_templates')
    .select('id, name, category, mode, quorum, tiers')
    .eq('id', templateId)
    .single()

  const { data: bindings, error } = await service
    .from('approval_tier_approvers')
    .select('tier, approver_type, approver_user_id, min_band_rank')
    .eq('client_id', clientId)
    .eq('template_id', templateId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, template, bindings: bindings ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: BindBody = await req.json()
  const { clientId, templateId, tier, approverType, approverUserId, minBandRank } = body

  if (!clientId || !templateId || !Number.isInteger(tier)) {
    return Response.json({ error: 'clientId, templateId and tier are required' }, { status: 400 })
  }

  if (!APPROVER_TYPES.includes(approverType)) {
    return Response.json({ error: `Invalid approver type: ${approverType}` }, { status: 400 })
  }

  if (approverType === 'specific_user' && !approverUserId) {
    return Response.json({ error: 'Choose a person for this step' }, { status: 400 })
  }

  if (approverType === 'any_manager_at' && (minBandRank === undefined || minBandRank === null)) {
    return Response.json({ error: 'Choose a minimum band rank for this step' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authorise(service, user.id, clientId, templateId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  const { error } = await service
    .from('approval_tier_approvers')
    .upsert({
      client_id: clientId,
      template_id: templateId,
      tier,
      approver_type: approverType,
      approver_user_id: approverType === 'specific_user' ? approverUserId : null,
      min_band_rank: approverType === 'any_manager_at' ? minBandRank : null,
      assigned_by: caller?.id ?? null,
      assigned_at: new Date().toISOString(),
    }, { onConflict: 'client_id,template_id,tier' })

  if (error) {
    // 23514 is the approval_tier_approvers_client_check trigger: the chosen
    // person works at a different client. Reachable through a crafted request
    // even though the UI only ever offers this client's staff.
    if (error.code === '23514') {
      return Response.json(
        { error: 'That person does not work at this client' },
        { status: 400 }
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  const templateId = req.nextUrl.searchParams.get('templateId')
  const tier = Number(req.nextUrl.searchParams.get('tier'))

  if (!clientId || !templateId || !Number.isInteger(tier)) {
    return Response.json({ error: 'clientId, templateId and tier are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authorise(service, user.id, clientId, templateId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const { error } = await service
    .from('approval_tier_approvers')
    .delete()
    .eq('client_id', clientId)
    .eq('template_id', templateId)
    .eq('tier', tier)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
