import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { getBandRanksByGroup } from '@/app/lib/rule-engine/linkedPolicyGroups'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/policy-groups?search=<text> ──────────────────────────────
// Lists policy groups — reusable templates, no longer scoped to one
// client. Optional `search` filters by name/code (used by the searchable
// dropdown in quick-allot, clients/[id], and onboarding). Not scoped to a
// clientId: any TMC user with manage_policy can see every group belonging
// to THEIR TMC, since groups are meant to be found and reused across their
// own clients — that's the whole point of the Policy Master model. Scoping
// stops at the TMC boundary though; a group is never visible to another TMC.
//
// ── POST /api/tmc/policy-groups ────────────────────────────────────────────
// Creates a new policy group template owned by the caller's TMC, covering an
// explicit set of band ranks. No clientId — a group isn't owned by a client
// at creation time, only linked to one later via
// /api/tmc/client-policy-groups (quick-allot, clients/[id], onboarding).
// ─────────────────────────────────────────────────────────────────────────────

interface CreateGroupBody {
  name: string
  code?: string
  description?: string
  bandRanks?: number[]
}

// Ranks arrive from a UI that lets an admin toggle arbitrary ranks, so
// normalise rather than trust: drop non-integers and negatives, dedupe, sort.
export function normaliseBandRanks(input: unknown): number[] {
  if (!Array.isArray(input)) return []
  const cleaned = input
    .map(Number)
    .filter(n => Number.isInteger(n) && n >= 0)
  return Array.from(new Set(cleaned)).sort((a, b) => a - b)
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  // manage_policy is checked without a specific clientId — groups are
  // global templates now, so this just confirms the caller has
  // manage_policy on SOME scope (their TMC), not on one particular client.
  const auth = await requireTmcPermission(service, user.id, 'manage_policy')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const search = req.nextUrl.searchParams.get('search')?.trim()

  let query = service
    .from('policy_groups')
    .select('id, name, code, description, created_at')
    .eq('tmc_id', auth.tmcId)
    .order('name')

  if (search) {
    // Matches name OR code — "PLCYGRP1" should find it whether typed as
    // the code or as part of the display name.
    query = query.or(`name.ilike.%${search}%,code.ilike.%${search}%`)
  }

  const { data: groups, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const groupIds = (groups ?? []).map(g => g.id)
  const ranksByGroup = await getBandRanksByGroup(service, groupIds)

  // Client count per group — lets the picker/list show "used by 4
  // clients" so an admin can gauge blast radius before editing a shared
  // template. No tmc_id filter is possible here (the link table has no such
  // column) and none is needed: groupIds is already scoped to this TMC
  // above, and client-policy-groups only ever links a client to a group
  // when both belong to the caller's TMC.
  const countByGroup = new Map<string, number>()
  if (groupIds.length > 0) {
    const { data: links } = await service
      .from('client_policy_groups')
      .select('policy_group_id')
      .in('policy_group_id', groupIds)
    for (const l of links ?? []) {
      countByGroup.set(l.policy_group_id, (countByGroup.get(l.policy_group_id) ?? 0) + 1)
    }
  }

  const enriched = (groups ?? []).map(g => ({
    ...g,
    bandRanks: ranksByGroup.get(g.id) ?? [],
    clientCount: countByGroup.get(g.id) ?? 0,
  }))

  return Response.json({ ok: true, groups: enriched })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_policy')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: CreateGroupBody = await req.json()
  const { name, code, description } = body
  const bandRanks = normaliseBandRanks(body.bandRanks)

  if (!name?.trim()) {
    return Response.json({ error: 'name is required' }, { status: 400 })
  }

  // tmc_id is what makes the group findable and editable afterwards: the
  // DELETE handler and both policy-rules handlers gate on
  // auth.tmcId === group.tmc_id, and policy_rules carries a CHECK requiring
  // exactly one of client_id/tmc_id to be set. A group created without it
  // is unreachable by every other route.
  const { data: group, error } = await service
    .from('policy_groups')
    .insert({
      tmc_id: auth.tmcId,
      name: name.trim(),
      code: code?.trim() || null,
      description: description?.trim() || null,
    })
    .select('id, name, code, description, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      // Name and code are each unique per TMC — say which one collided
      // rather than always blaming the name.
      const clashedOnCode = code?.trim() && error.message.includes('code')
      return Response.json({
        error: clashedOnCode
          ? `A policy group with code "${code!.trim()}" already exists`
          : `A policy group named "${name.trim()}" already exists`,
      }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  // A brand-new group is linked to nothing, so the rank rows can't collide
  // with another group yet — but insert them after the group exists so the
  // FK holds, and clean up if they fail rather than leaving a group whose
  // coverage silently doesn't match what was asked for.
  if (bandRanks.length > 0) {
    const { error: rankError } = await service
      .from('policy_group_band_ranks')
      .insert(bandRanks.map(band_rank => ({ policy_group_id: group.id, band_rank })))

    if (rankError) {
      await service.from('policy_groups').delete().eq('id', group.id)
      return Response.json({ error: rankError.message }, { status: 500 })
    }
  }

  return Response.json(
    { ok: true, group: { ...group, bandRanks, clientCount: 0 } },
    { status: 201 }
  )
}
