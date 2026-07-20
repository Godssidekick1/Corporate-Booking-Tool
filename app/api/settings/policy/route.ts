import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── GET /api/settings/policy?groupId=<uuid|null> ────────────────────────────
// Returns the latest non-deleted version's rules for the given policy group
// (or ungrouped rules if groupId is omitted), merged with the TMC's master
// rules so the admin can see inherited + locked values alongside their own.
//
// ── POST /api/settings/policy ────────────────────────────────────────────────
// Inserts a new version of rules. Never updates or deletes existing rows —
// each save is a new version, preserving full history for audit purposes.
// Rejects the save entirely if the submitted rows attempt to change a rule
// that the TMC has locked.
// ─────────────────────────────────────────────────────────────────────────────

interface PolicyRuleInput {
  band: string
  travel_type: string
  limit_key: string
  limit_value: number
  policy_group_id?: string | null
}

async function getEmployeeContext(userId: string, service: ReturnType<typeof createServiceClient>) {
  const { data: employee, error } = await service
    .from('employees')
    .select('company_id, role')
    .eq('id', userId)
    .single()

  if (error || !employee) return null
  return employee
}

async function getLatestVersionRows(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  policyGroupId: string | null
) {
  // Find the latest non-deleted version number for this scope
  let versionQuery = service
    .from('policy_rules')
    .select('version')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('version', { ascending: false })
    .limit(1)

  versionQuery = policyGroupId
    ? versionQuery.eq('policy_group_id', policyGroupId)
    : versionQuery.is('policy_group_id', null)

  const { data: latest } = await versionQuery.maybeSingle()

  if (!latest) return { version: 0, rows: [] }

  let rowsQuery = service
    .from('policy_rules')
    .select('id, band_id, band_code, travel_type, limit_key, limit_value, locked, version')
    .eq('company_id', companyId)
    .eq('version', latest.version)
    .is('deleted_at', null)

  rowsQuery = policyGroupId
    ? rowsQuery.eq('policy_group_id', policyGroupId)
    : rowsQuery.is('policy_group_id', null)

  const { data: rows } = await rowsQuery

  return { version: latest.version, rows: rows ?? [] }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const employee = await getEmployeeContext(user.id, service)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (employee.role !== 'admin') {
    return Response.json({ error: 'Only admins can view policy settings' }, { status: 403 })
  }

  const companyId = employee.company_id
  const groupIdParam = req.nextUrl.searchParams.get('groupId')
  const policyGroupId = groupIdParam && groupIdParam !== 'null' ? groupIdParam : null

  // Company's own current rules for this group
  const { version, rows } = await getLatestVersionRows(service, companyId, policyGroupId)

  // TMC master rules — for display as "inherited" values. These are never
  // editable here; they're shown so the admin can see what they're overriding.
  const { data: company } = await service
    .from('companies')
    .select('tmc_id')
    .eq('id', companyId)
    .single()

  let tmcRows: { band_code: string; travel_type: string; limit_key: string; limit_value: number; locked: boolean }[] = []
  if (company?.tmc_id) {
    const { data: tmcVersionRow } = await service
      .from('policy_rules')
      .select('version')
      .eq('tmc_id', company.tmc_id)
      .is('deleted_at', null)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (tmcVersionRow) {
      const { data } = await service
        .from('policy_rules')
        .select('band_code, travel_type, limit_key, limit_value, locked')
        .eq('tmc_id', company.tmc_id)
        .eq('version', tmcVersionRow.version)
        .is('deleted_at', null)
      tmcRows = data ?? []
    }
  }

  // Available policy groups for this company, so the frontend can offer a selector
  const { data: groups } = await service
    .from('policy_groups')
    .select('id, name, description')
    .eq('company_id', companyId)
    .order('name')

  return Response.json({
    ok: true,
    version,
    rows,
    tmcRows,
    groups: groups ?? [],
    policyGroupId,
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const employee = await getEmployeeContext(user.id, service)

  if (!employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (employee.role !== 'admin') {
    return Response.json({ error: 'Only admins can update policy' }, { status: 403 })
  }

  const companyId = employee.company_id
  const { policy, policyGroupId }: { policy: PolicyRuleInput[]; policyGroupId: string | null } =
    await req.json()

  if (!policy || !Array.isArray(policy) || policy.length === 0) {
    return Response.json({ error: 'Policy data is required' }, { status: 400 })
  }

  // If a policyGroupId was given, confirm it actually belongs to this company —
  // prevents cross-tenant writes via a forged id.
  if (policyGroupId) {
    const { data: group } = await service
      .from('policy_groups')
      .select('id')
      .eq('id', policyGroupId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!group) {
      return Response.json({ error: 'Policy group not found for this company' }, { status: 404 })
    }
  }

  const { data: bands, error: bandsError } = await service
    .from('bands')
    .select('id, code')
    .eq('company_id', companyId)

  if (bandsError || !bands) {
    return Response.json({ error: 'Could not load bands' }, { status: 500 })
  }
  const bandMap = Object.fromEntries(bands.map(b => [b.code, b.id]))

  // ── Load the current version's rows to check for locked-row violations ────
  const { version: currentVersion, rows: currentRows } = await getLatestVersionRows(
    service,
    companyId,
    policyGroupId
  )

  const lockedKeySet = new Set(
    currentRows
      .filter(r => r.locked)
      .map(r => `${r.band_code}::${r.travel_type}::${r.limit_key}`)
  )

  // ── Build the new version's rows, deduping within this submission ─────────
  const seen = new Set<string>()
  const newRows: object[] = []

  for (const input of policy) {
    const bandId = bandMap[input.band]
    if (!bandId) {
      return Response.json({ error: `Unknown band: ${input.band}` }, { status: 400 })
    }

    const dedupeKey = `${input.band}::${input.travel_type}::${input.limit_key}`

    if (seen.has(dedupeKey)) {
      return Response.json(
        { error: `Duplicate rule submitted for band ${input.band}, ${input.travel_type}, ${input.limit_key}` },
        { status: 400 }
      )
    }
    seen.add(dedupeKey)

    if (lockedKeySet.has(dedupeKey)) {
      return Response.json(
        {
          error: `This rule is locked by your TMC and cannot be edited: ${input.travel_type} / ${input.limit_key} (band ${input.band})`,
          code: 'LOCKED_RULE_EDIT_ATTEMPTED',
        },
        { status: 403 }
      )
    }

    newRows.push({
      company_id: companyId,
      tmc_id: null,
      policy_group_id: policyGroupId,
      band_id: bandId,
      band_code: input.band,
      travel_type: input.travel_type,
      limit_key: input.limit_key,
      limit_value: Number(input.limit_value),
      locked: false, // admins never set locked — only the TMC can, from tmc/policy
      version: currentVersion + 1,
      updated_by: user.id,
    })
  }

  // Carry forward any locked rows unchanged into the new version, so the new
  // version is a complete, self-contained snapshot rather than a partial diff.
  for (const row of currentRows) {
    if (!row.locked) continue
    newRows.push({
      company_id: companyId,
      tmc_id: null,
      policy_group_id: policyGroupId,
      band_id: row.band_id,
      band_code: row.band_code,
      travel_type: row.travel_type,
      limit_key: row.limit_key,
      limit_value: row.limit_value,
      locked: true,
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

// ── DELETE /api/settings/policy ──────────────────────────────────────────────
// Note: version deletion is a TMC-admin action (per product decision), not
// exposed here for corporate admins. See tmc/policy route once built.