import { createServiceClient } from '@/utils/supabase/service'
import { getLinkedPolicyGroups, groupsCoveringRank } from './linkedPolicyGroups'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface ResolvedPolicy {
  ok: true
  policyGroupId: string
  policyGroupName: string
  bandCode: string
  bandRank: number
  version: number
  limits: Record<string, number | boolean>
}

export interface PolicyBlocked {
  ok: false
  reason: 'no_band' | 'no_policy_group' | 'overlapping_policy_groups' | 'no_policy_rules'
  message: string
}

export type PolicyResolution = ResolvedPolicy | PolicyBlocked

// ── toStoredCategory ──────────────────────────────────────────────────────────
function toStoredCategory(travelType: string): string {
  if (travelType.startsWith('flight')) return 'flight'
  if (travelType === 'car_rental') return 'car'
  return travelType
}

// ── resolveEffectivePolicy ────────────────────────────────────────────────────
// Policy Master model: policy_groups are reusable, company-agnostic templates
// covering an explicit set of band ranks (policy_group_band_ranks), linked to
// companies via company_policy_groups (many-to-many — a company can use
// several groups covering different ranks, and the same group can be shared
// live across multiple companies). Rules within a group are keyed by
// band_rank, not a specific company's band row, so the same group's limits
// apply positionally regardless of what a company calls its bands ("L3",
// "A3", "C" all just mean rank 3).
//
// Coverage is a set rather than a range so a group can span non-contiguous
// ranks (1, 4, 7) — and so a half-configured group covers nothing rather than
// silently covering everything, which is what unbounded NULL range ends did.
//
// Resolution: employee -> band_code -> that company's own bands row -> rank
// -> which of the company's linked groups covers that rank -> that group's
// rules at that rank. Exactly one group should ever match a given rank
// (enforced by constraint triggers on company_policy_groups and
// policy_group_band_ranks) — more than one match here means something got
// past those guards, surfaced as its own distinct blocked reason rather than
// silently picking one.
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveEffectivePolicy(
  service: ServiceClient,
  employeeId: string,
  travelType: string
): Promise<PolicyResolution> {
  const { data: employee } = await service
    .from('employees')
    .select('company_id, band_code')
    .eq('id', employeeId)
    .single()

  if (!employee || !employee.band_code) {
    return {
      ok: false,
      reason: 'no_band',
      message: 'This employee has no band assigned. Contact your TMC or corporate admin.',
    }
  }

  const { data: bandRow } = await service
    .from('bands')
    .select('rank')
    .eq('company_id', employee.company_id)
    .eq('code', employee.band_code)
    .maybeSingle()

  if (!bandRow) {
    return {
      ok: false,
      reason: 'no_band',
      message: `Band "${employee.band_code}" is not configured for this company. Contact your TMC or corporate admin.`,
    }
  }

  const bandRank = bandRow.rank

  const groups = await getLinkedPolicyGroups(service, employee.company_id)

  if (groups.length === 0) {
    return {
      ok: false,
      reason: 'no_policy_group',
      message: 'No policy group has been linked to this company yet. Contact your TMC.',
    }
  }

  const matchingGroups = groupsCoveringRank(groups, bandRank)

  if (matchingGroups.length === 0) {
    return {
      ok: false,
      reason: 'no_policy_group',
      message: `No policy group covers band rank ${bandRank} (${employee.band_code}) for this company yet. Contact your TMC.`,
    }
  }

  if (matchingGroups.length > 1) {
    return {
      ok: false,
      reason: 'overlapping_policy_groups',
      message: `Multiple policy groups (${matchingGroups.map(g => g.name).join(', ')}) cover band rank ${bandRank} for this company — this is a configuration error. Contact your TMC to resolve the overlap.`,
    }
  }

  const group = matchingGroups[0]

  const storedCategory = toStoredCategory(travelType)
  const categoriesToFetch = Array.from(new Set([storedCategory, 'approval']))

  // One query, not two. This used to read the latest version number and then
  // fetch that version's rows separately, which left a window: anything that
  // soft-deleted those rows in between (retiring a rank's rules when a group's
  // coverage shrinks, for one) meant the second query found nothing and the
  // booking was reported as unevaluated rather than checked. Reading rows and
  // version together takes a single snapshot, so there is no gap to race
  // through.
  //
  // company_id is deliberately NOT filtered — rules belong to the group, not a
  // company, since the whole point of a shared group is that its rules are the
  // same regardless of which company is asking.
  //
  // travel_type is filtered in memory rather than in the query, deliberately.
  // "Latest version" has to mean the newest version of the WHOLE rule set for
  // this rank — if it meant the newest version that happens to contain the
  // requested category, then clearing every flight limit in a new version
  // would silently fall back to the previous version's flight limits instead
  // of reporting that none are configured. Stale limits served as current are
  // worse than an honest "unevaluated".
  //
  // This reads every live version for one (group, rank) slice and keeps the
  // newest in memory — a few dozen rows per save, so it stays small. If a
  // group ever accumulates enough history to matter, the bounded form is a
  // DISTINCT ON in a Postgres function, not a second round trip.
  const { data: candidateRows } = await service
    .from('policy_rules')
    .select('version, travel_type, limit_key, limit_value, limit_bool')
    .eq('policy_group_id', group.id)
    .eq('band_rank', bandRank)
    .is('deleted_at', null)
    .order('version', { ascending: false })

  if (!candidateRows || candidateRows.length === 0) {
    return {
      ok: false,
      reason: 'no_policy_rules',
      message: `No policy has been configured for band rank ${bandRank} in policy group "${group.name}" yet. Contact your TMC.`,
    }
  }

  // Ordered version-desc above, so the first row carries the newest version.
  const latestVersion = candidateRows[0].version
  const rows = candidateRows.filter(
    r => r.version === latestVersion && categoriesToFetch.includes(r.travel_type)
  )

  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'no_policy_rules',
      message: `No policy rules exist for ${travelType} at this employee's band in policy group "${group.name}" yet. Contact your TMC.`,
    }
  }

  const limits: Record<string, number | boolean> = {}
  for (const row of rows) {
    if (row.limit_value !== null && row.limit_value !== undefined) {
      limits[row.limit_key] = row.limit_value
    } else if (row.limit_bool !== null && row.limit_bool !== undefined) {
      limits[row.limit_key] = row.limit_bool
    }
  }

  return {
    ok: true,
    policyGroupId: group.id,
    policyGroupName: group.name,
    bandCode: employee.band_code,
    bandRank,
    version: latestVersion,
    limits,
  }
}