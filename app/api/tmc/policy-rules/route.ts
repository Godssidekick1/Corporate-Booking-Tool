import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/policy-rules?companyId=<uuid>&groupId=<uuid> ────────────────
// Latest version's rules for one company + policy group, across all bands.
//
// ── POST /api/tmc/policy-rules ────────────────────────────────────────────────
// Inserts a new version (append-only, same versioning pattern as the
// corp-admin route this replaces). Supports both numeric (limit_value) and
// boolean (limit_bool) rules in the same submission.
// ─────────────────────────────────────────────────────────────────────────────

interface RuleInput {
  band_code: string
  travel_type: string
  limit_key: string
  limit_value?: number | null
  limit_bool?: boolean | null
}

async function getLatestVersionRows(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  policyGroupId: string
) {
  const { data: latest } = await service
    .from('policy_rules')
    .select('version')
    .eq('company_id', companyId)
    .eq('policy_group_id', policyGroupId)
    .is('deleted_at', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latest) return { version: 0, rows: [] }

  const { data: rows } = await service
    .from('policy_rules')
    .select('id, band_code, travel_type, limit_key, limit_value, limit_bool, version')
    .eq('company_id', companyId)
    .eq('policy_group_id', policyGroupId)
    .eq('version', latest.version)
    .is('deleted_at', null)

  return { version: latest.version, rows: rows ?? [] }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const companyId = req.nextUrl.searchParams.get('companyId')
  const groupId = req.nextUrl.searchParams.get('groupId')

  if (!companyId || !groupId) {
    return Response.json({ error: 'companyId and groupId are required' }, { status: 400 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { version, rows } = await getLatestVersionRows(service, companyId, groupId)

  return Response.json({ ok: true, version, rows })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { companyId, policyGroupId, rules }: {
    companyId: string
    policyGroupId: string
    rules: RuleInput[]
  } = await req.json()

  if (!companyId || !policyGroupId || !rules || !Array.isArray(rules) || rules.length === 0) {
    return Response.json({ error: 'companyId, policyGroupId, and rules are required' }, { status: 400 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: group } = await service
    .from('policy_groups')
    .select('id')
    .eq('id', policyGroupId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!group) {
    return Response.json({ error: 'Policy group not found for this company' }, { status: 404 })
  }

  const { version: currentVersion } = await getLatestVersionRows(service, companyId, policyGroupId)

  const seen = new Set<string>()
  const newRows: object[] = []

  for (const input of rules) {
    if (!input.band_code || !input.travel_type || !input.limit_key) {
      return Response.json({ error: 'Each rule needs band_code, travel_type, and limit_key' }, { status: 400 })
    }

    const isNumeric = input.limit_value !== undefined && input.limit_value !== null
    const isBool = input.limit_bool !== undefined && input.limit_bool !== null

    if (!isNumeric && !isBool) {
      return Response.json(
        { error: `Rule ${input.band_code}/${input.travel_type}/${input.limit_key} needs either limit_value or limit_bool` },
        { status: 400 }
      )
    }
    if (isNumeric && isBool) {
      return Response.json(
        { error: `Rule ${input.band_code}/${input.travel_type}/${input.limit_key} cannot set both limit_value and limit_bool` },
        { status: 400 }
      )
    }

    const dedupeKey = `${input.band_code}::${input.travel_type}::${input.limit_key}`
    if (seen.has(dedupeKey)) {
      return Response.json({ error: `Duplicate rule: ${dedupeKey}` }, { status: 400 })
    }
    seen.add(dedupeKey)

    newRows.push({
      company_id: companyId,
      tmc_id: null,
      policy_group_id: policyGroupId,
      band_id: null, // no longer used for matching — band_code is authoritative
      band_code: input.band_code,
      travel_type: input.travel_type,
      limit_key: input.limit_key,
      limit_value: isNumeric ? Number(input.limit_value) : null,
      limit_bool: isBool ? Boolean(input.limit_bool) : null,
      locked: false,
      version: currentVersion + 1,
      updated_by: user.id,
    })
  }

  const { error: insertError } = await service.from('policy_rules').insert(newRows)

  if (insertError) {
    return Response.json({ error: insertError.message }, { status: 500 })
  }

  return Response.json({ ok: true, newVersion: currentVersion + 1 })
}