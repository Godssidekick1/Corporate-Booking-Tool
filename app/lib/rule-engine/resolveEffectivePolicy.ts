import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface ResolvedPolicy {
  ok: true
  policyGroupId: string
  policyGroupName: string
  bandCode: string
  version: number
  limits: Record<string, number>
}

export interface PolicyBlocked {
  ok: false
  reason: 'no_policy_group' | 'no_policy_rules'
  message: string
}

export type PolicyResolution = ResolvedPolicy | PolicyBlocked

// ── resolveEffectivePolicy ────────────────────────────────────────────────────
// The Rule Engine's foundation: given an employee and a travel type, returns
// the limits that apply to them right now.
//
// Every employee must belong to exactly one policy group (enforced at
// assignment time — see employee_policy_groups). Within that group, rules
// are further keyed by band_code, so a single group can still differentiate
// e.g. L1 vs L3 even though both are in the same group.
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

  const { data: rows } = await service
    .from('policy_rules')
    .select('limit_key, limit_value')
    .eq('company_id', employee.company_id)
    .eq('policy_group_id', policyGroupId)
    .eq('band_code', employee.band_code)
    .eq('travel_type', travelType)
    .eq('version', latestVersionRow.version)
    .is('deleted_at', null)

  if (!rows || rows.length === 0) {
    return {
      ok: false,
      reason: 'no_policy_rules',
      message: `No policy rules exist for ${travelType} in this employee's policy group yet. Contact your TMC.`,
    }
  }

  const limits: Record<string, number> = {}
  for (const row of rows) {
    limits[row.limit_key] = row.limit_value
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