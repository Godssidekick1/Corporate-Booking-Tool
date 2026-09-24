import { createClient } from '@/utils/supabase/server'
import * as policy from '@/app/lib/repositories/policy'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'

// ── GET /api/tmc/policy-rules?groupId=<uuid> ──────────────────────────────
// The latest version's rules for one policy group. ONE set, not one per rank:
// the group's rank set says who it covers, the rules say what they get.
//
// ── POST /api/tmc/policy-rules ────────────────────────────────────────────
// Inserts a new version (append-only — same versioning pattern as before,
// genuinely unchanged). Rules used to carry band_rank as well, which let a
// group covering ranks 1-3 hold three sets of limits free to disagree. Ranks
// needing different limits are a different group, which is what a policy group
// was always supposed to mean.
// ─────────────────────────────────────────────────────────────────────────────

interface RuleInput {
  travel_type: string
  limit_key: string
  limit_value?: number | null
  limit_bool?: boolean | null
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const groupId = req.nextUrl.searchParams.get('groupId')

  if (!groupId) {
    return Response.json({ error: 'groupId is required' }, { status: 400 })
  }

  // No clientId to check per-client access against anymore — just confirm
  // the caller manages policy for the TMC that owns this group.
  const group = await policy.groupOwner(db, groupId)

  if (!group) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_policy')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== group.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  const version = await policy.latestVersion(db, groupId)
  const rows = version > 0 ? await policy.rulesAtVersion(db, groupId, version) : []

  return Response.json({ ok: true, version, rows })
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { policyGroupId, rules }: {
    policyGroupId: string
    rules: RuleInput[]
  } = await req.json()

  if (!policyGroupId || !rules || !Array.isArray(rules) || rules.length === 0) {
    return Response.json({ error: 'policyGroupId and rules are required' }, { status: 400 })
  }

  const group = await policy.groupOwner(db, policyGroupId)

  if (!group) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_policy')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== group.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  // Still checked, and for the same reason as before: a group covering no ranks
  // reaches nobody, so its rules could never resolve. The check is no longer
  // PER RULE — rules are not filed against a rank any more — but a group with an
  // empty rank set is still an empty policy, and saving limits into one is
  // almost certainly not what the admin thinks they are doing.
  const coveredRanks = (await policy.bandRanksByGroup(db, [policyGroupId])).get(policyGroupId) ?? []

  if (coveredRanks.length === 0) {
    return Response.json(
      { error: 'This policy group covers no band ranks yet. Add at least one rank before saving rules.' },
      { status: 400 }
    )
  }

  const currentVersion = await policy.latestVersion(db, policyGroupId)
  const updatedBy = (await employees.traveller(db, user.id))?.id ?? null

  const seen = new Set<string>()
  const newRows: policy.NewRule[] = []

  for (const input of rules) {
    if (!input.travel_type || !input.limit_key) {
      return Response.json({ error: 'Each rule needs travel_type and limit_key' }, { status: 400 })
    }

    const isNumeric = input.limit_value !== undefined && input.limit_value !== null
    const isBool = input.limit_bool !== undefined && input.limit_bool !== null

    if (!isNumeric && !isBool) {
      return Response.json(
        { error: `Rule (${input.travel_type}/${input.limit_key}) needs either limit_value or limit_bool` },
        { status: 400 }
      )
    }
    if (isNumeric && isBool) {
      return Response.json(
        { error: `Rule (${input.travel_type}/${input.limit_key}) cannot set both limit_value and limit_bool` },
        { status: 400 }
      )
    }

    const dedupeKey = `${input.travel_type}::${input.limit_key}`
    if (seen.has(dedupeKey)) {
      return Response.json({ error: `Duplicate rule: ${dedupeKey}` }, { status: 400 })
    }
    seen.add(dedupeKey)

    newRows.push({
      tmc_id: group.tmc_id,
      policy_group_id: policyGroupId,
      travel_type: input.travel_type,
      limit_key: input.limit_key,
      limit_value: isNumeric ? Number(input.limit_value) : null,
      limit_bool: isBool ? Boolean(input.limit_bool) : null,
      version: currentVersion + 1,
      updated_by: updatedBy,
    })
  }

  // One statement, so the new version lands whole or not at all.
  await policy.insertRules(db, newRows)

  return Response.json({ ok: true, newVersion: currentVersion + 1 })
})
