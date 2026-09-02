import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { getLinkedPolicyGroups, groupsCoveringRank } from '@/app/lib/rule-engine/linkedPolicyGroups'

// ── GET /api/settings/policy ─────────────────────────────────────────────────
// Read-only view of the policy in force for the corporate admin's client.
//
// Under the Policy Master model the TMC owns all policy: groups are TMC-level
// templates shared across clients, so a corporate admin editing one would
// silently change limits for every other client using the same template.
// Corporate admins therefore read here and edit nothing — there is no POST.
//
// Rules are stored against an integer band_rank, which is client-agnostic by
// design. This route maps each rank back through the client's own `bands` rows
// so the admin sees their own labels ("L3 · Senior") rather than bare ranks.
//
// Version history and deletion remain TMC-admin actions, exposed under
// /api/tmc/policy-rules — deliberately not surfaced here.
// ─────────────────────────────────────────────────────────────────────────────

interface EffectiveRow {
  band_code: string
  band_rank: number
  travel_type: string
  limit_key: string
  limit_value: number | null
  limit_bool: boolean | null
  policy_group_id: string
  group_name: string
}

type UnresolvedReason = 'no_policy_group' | 'overlapping_policy_groups' | 'no_policy_rules'

interface UnresolvedBand {
  band_code: string
  band_label: string
  band_rank: number
  reason: UnresolvedReason
  detail: string
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: employee } = await service
    .from('employees')
    .select('client_id, role')
    .eq('id', user.id)
    .single()

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (employee.role !== 'admin') {
    return Response.json({ error: 'Only admins can view policy settings' }, { status: 403 })
  }

  const clientId = employee.client_id

  const { data: bands } = await service
    .from('bands')
    .select('code, label, rank')
    .eq('client_id', clientId)
    .order('rank')

  const groups = await getLinkedPolicyGroups(service, clientId)

  if (groups.length === 0) {
    return Response.json({
      ok: true,
      managedByTmc: true,
      bands: bands ?? [],
      groups: [],
      rows: [],
      unresolved: (bands ?? []).map(b => ({
        band_code: b.code,
        band_label: b.label,
        band_rank: b.rank,
        reason: 'no_policy_group' as const,
        detail: 'No policy group has been linked to this client yet.',
      })),
    })
  }

  // Latest live version per group, then that version's rules. Fetched per
  // group rather than in one sweep because each group versions independently,
  // so there is no single version number to filter on — and pulling every
  // version to reduce in JS would grow with save history.
  const ruleSets = await Promise.all(
    groups.map(async group => {
      const { data: latest } = await service
        .from('policy_rules')
        .select('version')
        .eq('policy_group_id', group.id)
        .is('deleted_at', null)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!latest) return { group, version: 0, rules: [] }

      const { data: rules } = await service
        .from('policy_rules')
        .select('band_rank, travel_type, limit_key, limit_value, limit_bool')
        .eq('policy_group_id', group.id)
        .eq('version', latest.version)
        .is('deleted_at', null)

      return { group, version: latest.version, rules: rules ?? [] }
    })
  )

  const ruleSetByGroupId = new Map(ruleSets.map(rs => [rs.group.id, rs]))

  const rows: EffectiveRow[] = []
  const unresolved: UnresolvedBand[] = []

  for (const band of bands ?? []) {
    const covering = groupsCoveringRank(groups, band.rank)

    if (covering.length === 0) {
      unresolved.push({
        band_code: band.code,
        band_label: band.label,
        band_rank: band.rank,
        reason: 'no_policy_group',
        detail: `No policy group covers rank ${band.rank}.`,
      })
      continue
    }

    // Mirrors resolveEffectivePolicy: more than one match is a configuration
    // error surfaced as such, never silently resolved by picking one.
    if (covering.length > 1) {
      unresolved.push({
        band_code: band.code,
        band_label: band.label,
        band_rank: band.rank,
        reason: 'overlapping_policy_groups',
        detail: `Rank ${band.rank} is covered by more than one group (${covering.map(g => g.name).join(', ')}).`,
      })
      continue
    }

    const group = covering[0]
    const ruleSet = ruleSetByGroupId.get(group.id)
    const bandRules = (ruleSet?.rules ?? []).filter(r => r.band_rank === band.rank)

    if (bandRules.length === 0) {
      unresolved.push({
        band_code: band.code,
        band_label: band.label,
        band_rank: band.rank,
        reason: 'no_policy_rules',
        detail: `"${group.name}" has no rules configured at rank ${band.rank}.`,
      })
      continue
    }

    for (const rule of bandRules) {
      rows.push({
        band_code: band.code,
        band_rank: band.rank,
        travel_type: rule.travel_type,
        limit_key: rule.limit_key,
        limit_value: rule.limit_value,
        limit_bool: rule.limit_bool,
        policy_group_id: group.id,
        group_name: group.name,
      })
    }
  }

  return Response.json({
    ok: true,
    managedByTmc: true,
    bands: bands ?? [],
    groups: ruleSets.map(rs => ({
      id: rs.group.id,
      name: rs.group.name,
      code: rs.group.code,
      bandRanks: rs.group.bandRanks,
      version: rs.version,
    })),
    rows,
    unresolved,
  })
}
