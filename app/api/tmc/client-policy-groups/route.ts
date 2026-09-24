import { createClient } from '@/utils/supabase/server'
import * as policy from '@/app/lib/repositories/policy'
import * as clients from '@/app/lib/repositories/clients'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'

// ── GET /api/tmc/client-policy-groups?clientId=<uuid> ──────────────────
// Lists every policy group currently linked to a client, with the band ranks
// it covers, so a UI can show "this client uses PLCYGRP1 (ranks 1, 2) and
// PLCYGRP2 (ranks 4, 7)" and know which ranks are still uncovered.
//
// ── POST /api/tmc/client-policy-groups ───────────────────────────────────
// Links a policy group to a client. Rejects if the group's rank set would
// intersect any group already linked to that client — per explicit product
// direction, overlapping coverage is a configuration error to prevent at
// assignment time, not something resolveEffectivePolicy.ts should have to
// arbitrate at read time.
//
// ── DELETE /api/tmc/client-policy-groups?clientId=<uuid>&policyGroupId=<uuid> ──
// Unlinks a group from a client. Doesn't touch the group itself or any
// other client using it — this only removes the one link row.
// ─────────────────────────────────────────────────────────────────────────────

interface LinkBody {
  clientId: string
  policyGroupId: string
}

// Coverage is an explicit set of ranks, so a collision is just a shared
// member. This replaced a min/max range comparison that needed sentinel
// values for unbounded sides and still couldn't express non-contiguous
// coverage.
function sharedRanks(a: number[], b: number[]): number[] {
  const bSet = new Set(b)
  return a.filter(rank => bSet.has(rank))
}

// A tmc_admin passes requireTmcPermission for ANY clientId, so the client must
// be checked against their TMC explicitly. POST always did this; GET and
// DELETE did not, which let another TMC's admin read -- and unlink -- a
// client's policy groups by id.
async function clientIsTmcs(clientId: string, tmcId: string | null | undefined): Promise<boolean> {
  const client = await clients.tenancy(db, clientId)
  return Boolean(client && tmcId && client.tmc_id === tmcId)
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) {
    return Response.json({ error: 'clientId is required' }, { status: 400 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_policy', clientId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (!(await clientIsTmcs(clientId, auth.tmcId))) {
    return Response.json({ error: 'Client not found for this TMC' }, { status: 404 })
  }

  const links = await policy.links(db, clientId)

  const groupIds = links.map(l => l.policy_group_id)
  if (groupIds.length === 0) {
    return Response.json({ ok: true, links: [] })
  }

  const [groups, ranksByGroup] = await Promise.all([
    policy.groupLabels(db, groupIds),
    policy.bandRanksByGroup(db, groupIds),
  ])
  const groupById = new Map(groups.map(g => [g.id, g]))

  const enriched = links
    .map(l => {
      const group = groupById.get(l.policy_group_id)
      return {
        policyGroupId: l.policy_group_id,
        assignedAt: l.assigned_at,
        group: group
          ? { ...group, bandRanks: ranksByGroup.get(l.policy_group_id) ?? [] }
          : null,
      }
    })
    // Ordered by lowest covered rank so the list reads bottom-of-org upward,
    // and gaps between groups are visible at a glance.
    .sort((a, b) => (a.group?.bandRanks[0] ?? Infinity) - (b.group?.bandRanks[0] ?? Infinity))

  return Response.json({ ok: true, links: enriched })
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: LinkBody = await req.json()
  const { clientId, policyGroupId } = body

  if (!clientId || !policyGroupId) {
    return Response.json({ error: 'clientId and policyGroupId are required' }, { status: 400 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_policy', clientId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const newGroup = await policy.groupOwner(db, policyGroupId)

  if (!newGroup) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  if (auth.tmcId !== newGroup.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  // Confirm the client actually belongs to this TMC too — a crafted
  // clientId from another TMC's client shouldn't be linkable even if the
  // caller passes the manage_policy check generically.
  if (!(await clientIsTmcs(clientId, auth.tmcId))) {
    return Response.json({ error: 'Client not found for this TMC' }, { status: 404 })
  }

  const existingGroupIds = (await policy.links(db, clientId)).map(l => l.policy_group_id)

  if (existingGroupIds.includes(policyGroupId)) {
    return Response.json({ error: `"${newGroup.name}" is already linked to this client` }, { status: 409 })
  }

  const ranksByGroup = await policy.bandRanksByGroup(db, [policyGroupId, ...existingGroupIds])
  const newRanks = ranksByGroup.get(policyGroupId) ?? []

  if (newRanks.length === 0) {
    return Response.json({
      error: `"${newGroup.name}" covers no band ranks yet, so linking it would have no effect. Add ranks to the group first.`,
    }, { status: 400 })
  }

  for (const existing of await policy.groupLabels(db, existingGroupIds)) {
    const clash = sharedRanks(newRanks, ranksByGroup.get(existing.id) ?? [])
    if (clash.length > 0) {
      return Response.json({
        error: `"${newGroup.name}" overlaps with "${existing.name}" at band rank${clash.length > 1 ? 's' : ''} ${clash.join(', ')}, which is already linked to this client. Each linked group must cover distinct ranks.`,
      }, { status: 409 })
    }
  }

  try {
    await policy.link(db, clientId, policyGroupId, (await employees.traveller(db, user.id))?.id ?? null)
  } catch (err) {
    // An exclusion violation is the client_policy_groups_no_overlap
    // constraint trigger. The check above catches this in the ordinary case;
    // the trigger is the backstop for two links racing each other, where both
    // requests read the pre-insert state and neither sees the other's row.
    if (isConstraint(err, 'exclusion')) {
      return Response.json({ error: err.message }, { status: 409 })
    }
    throw err
  }

  return Response.json({ ok: true }, { status: 201 })
})

export const DELETE = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  const policyGroupId = req.nextUrl.searchParams.get('policyGroupId')

  if (!clientId || !policyGroupId) {
    return Response.json({ error: 'clientId and policyGroupId are required' }, { status: 400 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_policy', clientId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (!(await clientIsTmcs(clientId, auth.tmcId))) {
    return Response.json({ error: 'Client not found for this TMC' }, { status: 404 })
  }

  await policy.unlink(db, clientId, policyGroupId)

  return Response.json({ ok: true })
})
