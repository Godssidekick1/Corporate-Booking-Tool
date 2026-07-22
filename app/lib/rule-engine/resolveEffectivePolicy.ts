import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface ResolvedPolicy {
  ok: true
  policyGroupId: string
  policyGroupName: string
  bandCode: string
  version: number
  limits: Record<string, number | boolean>
}

export interface PolicyBlocked {
  ok: false
  reason: 'no_policy_group' | 'no_policy_rules'
  message: string
}

export type PolicyResolution = ResolvedPolicy | PolicyBlocked

// ── toStoredCategory ──────────────────────────────────────────────────────────
// The Policy editor stores rules under broad categories ('flight', 'hotel',
// 'car', 'general', 'approval') — the Rule Engine (and real booking flows)
// deal in more granular travel types ('flight_domestic',
// 'flight_international', 'car_rental', ...). The domestic/international
// split lives at the FIELD level (max_fare_domestic vs max_fare_intl), not
// as a separate travel_type row, so both collapse to 'flight' here. Add
// further mappings as new granular types are introduced.
// ─────────────────────────────────────────────────────────────────────────────

function toStoredCategory(travelType: string): string {
  if (travelType.startsWith('flight')) return 'flight'
  if (travelType === 'car_rental') return 'car'
  return travelType // 'hotel', 'car', 'general', 'approval' pass through unchanged
}

// ── resolveEffectivePolicy ────────────────────────────────────────────────────
// The Rule Engine's foundation: given an employee and a travel type, returns
// the limits that apply to them right now.
//
// Every employee must belong to exactly one policy group (enforced at
// assignment time — see employee_policy_groups). Within that group, rules
// are further keyed by band_code, so a single group can still differentiate
// e.g. L1 vs L3 even though both are in the same group.
//
// Approval thresholds (auto_approve_under / finance_approval_over) are
// stored under their own 'approval' category, separate from the specific
// travel category — but they apply universally regardless of travel type,
// so they're always fetched and merged in alongside whichever category the
// caller asked about.
//
// If the employee has no group, or the group has no rules configured for
// this travel_type yet, this returns an explicit block rather than silently
// falling back to a default — an unconfigured policy is a TMC/TC gap that
// should stop a booking, not guess at a limit.
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
      reason: 'no_policy_group',
      message: 'This employee has no band assigned. Contact your TMC or corporate admin.',
    }
  }

  const { data: groupMembership } = await service
    .from('employee_policy_groups')
    .select('policy_group_id, policy_groups(name)')
    .eq('employee_id', employeeId)
    .maybeSingle()

  if (!groupMembership) {
    return {
      ok: false,
      reason: 'no_policy_group',
      message: 'No policy group has been assigned to this employee yet. Contact your TMC.',
    }
  }

  const policyGroupId = groupMembership.policy_group_id
  const policyGroupName = (groupMembership.policy_groups as unknown as { name: string } | null)?.name ?? 'Unknown'

  // Latest non-deleted version for this exact scope
  const { data: latestVersionRow } = await service
    .from('policy_rules')
    .select('version')
    .eq('company_id', employee.company_id)
    .eq('policy_group_id', policyGroupId)
    .eq('band_code', employee.band_code)
    .is('deleted_at', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latestVersionRow) {
    return {
      ok: false,
      reason: 'no_policy_rules',
      message: `No policy has been configured for band ${employee.band_code} in policy group "${policyGroupName}" yet. Contact your TMC.`,
    }
  }

  const storedCategory = toStoredCategory(travelType)
  const categoriesToFetch = Array.from(new Set([storedCategory, 'approval']))

  const { data: rows } = await service
    .from('policy_rules')
    .select('limit_key, limit_value, limit_bool')
    .eq('company_id', employee.company_id)
    .eq('policy_group_id', policyGroupId)
    .eq('band_code', employee.band_code)
    .in('travel_type', categoriesToFetch)
    .eq('version', latestVersionRow.version)
    .is('deleted_at', null)

  if (!rows || rows.length === 0) {
    return {
      ok: false,
      reason: 'no_policy_rules',
      message: `No policy rules exist for ${travelType} in this employee's policy group yet. Contact your TMC.`,
    }
  }

  // Each row has exactly one of limit_value / limit_bool set (enforced at
  // write time by the policy-rules route) — merge whichever is present.
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
    policyGroupId,
    policyGroupName,
    bandCode: employee.band_code,
    version: latestVersionRow.version,
    limits,
  }
}