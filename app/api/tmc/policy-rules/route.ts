import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/policy-rules?groupId=<uuid> ──────────────────────────────
// Latest version's rules for one policy group, across every band_rank the
// group has rules for. No companyId anymore — rules belong to the group
// itself, not to any one company (that's the whole point of a shared,
// reusable template).
//
// ── POST /api/tmc/policy-rules ────────────────────────────────────────────
// Inserts a new version (append-only — same versioning pattern as before,
// genuinely unchanged). Keyed by band_rank (a plain integer — "rank 1",
// "rank 2"...) instead of a company-specific band_code, since a shared
// group has no single company's band labels to key against. The TMC admin
// building the group works in ranks directly; mapping a rank back to
// whatever a given company happens to call it ("L1", "A1", "1") is
// resolveEffectivePolicy.ts's job at read time, not this route's.
// ─────────────────────────────────────────────────────────────────────────────

interface RuleInput {
  band_rank: number
  travel_type: string
  limit_key: string
  limit_value?: number | null
  limit_bool?: boolean | null
}

async function getLatestVersionRows(
  service: ReturnType<typeof createServiceClient>,
  policyGroupId: string
) {
  const { data: latest } = await service
    .from('policy_rules')
    .select('version')
    .eq('policy_group_id', policyGroupId)
    .is('deleted_at', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latest) return { version: 0, rows: [] }

  const { data: rows } = await service
    .from('policy_rules')
    .select('id, band_rank, travel_type, limit_key, limit_value, limit_bool, version')
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
  const groupId = req.nextUrl.searchParams.get('groupId')

  if (!groupId) {
    return Response.json({ error: 'groupId is required' }, { status: 400 })
  }

  // No companyId to check per-company access against anymore — just confirm
  // the caller manages policy for the TMC that owns this group.
  const { data: group } = await service
    .from('policy_groups')
    .select('id, tmc_id')
    .eq('id', groupId)
    .maybeSingle()

  if (!group) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== group.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  const { version, rows } = await getLatestVersionRows(service, groupId)

  return Response.json({ ok: true, version, rows })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { policyGroupId, rules }: {
    policyGroupId: string
    rules: RuleInput[]
  } = await req.json()

  if (!policyGroupId || !rules || !Array.isArray(rules) || rules.length === 0) {
    return Response.json({ error: 'policyGroupId and rules are required' }, { status: 400 })
  }

  const { data: group } = await service
    .from('policy_groups')
    .select('id, tmc_id, min_band_rank, max_band_rank')
    .eq('id', policyGroupId)
    .maybeSingle()

  if (!group) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== group.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  const { version: currentVersion } = await getLatestVersionRows(service, policyGroupId)

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  const seen = new Set<string>()
  const newRows: object[] = []

  for (const input of rules) {
    if (input.band_rank === undefined || input.band_rank === null || !input.travel_type || !input.limit_key) {
      return Response.json({ error: 'Each rule needs band_rank, travel_type, and limit_key' }, { status: 400 })
    }

    // A rule outside the group's own declared rank range is almost
    // certainly a mistake (e.g. copy-pasted from another group's editor
    // state) — reject rather than silently accept a rule that
    // resolveEffectivePolicy.ts would never actually be able to reach for
    // this group, since it only matches groups whose range covers the
    // employee's rank in the first place.
    if (group.min_band_rank !== null && input.band_rank < group.min_band_rank) {
      return Response.json({ error: `Rank ${input.band_rank} is below this group's minimum rank (${group.min_band_rank})` }, { status: 400 })
    }
    if (group.max_band_rank !== null && input.band_rank > group.max_band_rank) {
      return Response.json({ error: `Rank ${input.band_rank} is above this group's maximum rank (${group.max_band_rank})` }, { status: 400 })
    }

    const isNumeric = input.limit_value !== undefined && input.limit_value !== null
    const isBool = input.limit_bool !== undefined && input.limit_bool !== null

    if (!isNumeric && !isBool) {
      return Response.json(
        { error: `Rule (rank ${input.band_rank}/${input.travel_type}/${input.limit_key}) needs either limit_value or limit_bool` },
        { status: 400 }
      )
    }
    if (isNumeric && isBool) {
      return Response.json(
        { error: `Rule (rank ${input.band_rank}/${input.travel_type}/${input.limit_key}) cannot set both limit_value and limit_bool` },
        { status: 400 }
      )
    }

    const dedupeKey = `${input.band_rank}::${input.travel_type}::${input.limit_key}`
    if (seen.has(dedupeKey)) {
      return Response.json({ error: `Duplicate rule: ${dedupeKey}` }, { status: 400 })
    }
    seen.add(dedupeKey)

    newRows.push({
      company_id: null,
      tmc_id: group.tmc_id,
      policy_group_id: policyGroupId,
      band_id: null,   // legacy column, no longer used for matching
      band_code: null, // legacy column, no longer used for matching
      band_rank: input.band_rank,
      travel_type: input.travel_type,
      limit_key: input.limit_key,
      limit_value: isNumeric ? Number(input.limit_value) : null,
      limit_bool: isBool ? Boolean(input.limit_bool) : null,
      locked: false,
      version: currentVersion + 1,
      updated_by: caller?.id ?? null,
    })
  }

  const { error: insertError } = await service.from('policy_rules').insert(newRows)

  if (insertError) {
    return Response.json({ error: insertError.message }, { status: 500 })
  }

  return Response.json({ ok: true, newVersion: currentVersion + 1 })
}