import { createClient } from '@/utils/supabase/server'
import * as policy from '@/app/lib/repositories/policy'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint, type ConstraintViolation } from '@/app/lib/db'

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

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // manage_policy is checked without a specific clientId — groups are
  // global templates now, so this just confirms the caller has
  // manage_policy on SOME scope (their TMC), not on one particular client.
  const auth = await requireTmcPermission(db, user.id, 'manage_policy')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  // Matches name OR code — "PLCYGRP1" should find it whether typed as
  // the code or as part of the display name.
  const groups = await policy.groupsForTmc(db, auth.tmcId, req.nextUrl.searchParams.get('search'))
  const groupIds = groups.map(g => g.id)

  // Client count per group — lets the picker/list show "used by 4
  // clients" so an admin can gauge blast radius before editing a shared
  // template. No tmc_id filter is possible here (the link table has no such
  // column) and none is needed: groupIds is already scoped to this TMC
  // above, and client-policy-groups only ever links a client to a group
  // when both belong to the caller's TMC.
  const [ranksByGroup, countByGroup] = await Promise.all([
    policy.bandRanksByGroup(db, groupIds),
    policy.clientCounts(db, groupIds),
  ])

  const enriched = groups.map(g => ({
    ...g,
    bandRanks: ranksByGroup.get(g.id) ?? [],
    clientCount: countByGroup.get(g.id) ?? 0,
  }))

  return Response.json({ ok: true, groups: enriched })
})

// Name and code are each unique per TMC. The code rule is enforced by TWO
// identical partial indexes (schema drift: idx_policy_groups_code_per_tmc
// predates policy_groups_tmc_id_code_key), and PostgreSQL reports whichever
// it checks first -- so either name means "that code is taken".
export const NAME_TAKEN = 'policy_groups_tmc_id_name_key'
const CODE_INDEXES = ['policy_groups_tmc_id_code_key', 'idx_policy_groups_code_per_tmc']

export function codeTaken(err: unknown): err is ConstraintViolation {
  return isConstraint(err, 'unique') && CODE_INDEXES.includes(err.constraint ?? '')
}

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_policy')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

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
  //
  // The group and its ranks in one transaction: a group whose coverage does
  // not match what was asked for is never visible, even briefly. (This used
  // to insert, then delete the group again by hand if the ranks failed.)
  try {
    const group = await transaction(async (tx) => {
      const created = await policy.insertGroup(tx, {
        tmc_id: tmcId,
        name: name.trim(),
        code: code?.trim() || null,
        description: description?.trim() || null,
      })
      await policy.addRanks(tx, created.id, bandRanks)
      return created
    }, { tenantId: tmcId, userId: user.id })

    return Response.json(
      { ok: true, group: { ...group, bandRanks, clientCount: 0 } },
      { status: 201 }
    )
  } catch (err) {
    // Name and code are each unique per TMC — say which one collided
    // rather than always blaming the name.
    if (codeTaken(err)) {
      return Response.json({ error: `A policy group with code "${code!.trim()}" already exists` }, { status: 409 })
    }
    if (isConstraint(err, 'unique', NAME_TAKEN)) {
      return Response.json({ error: `A policy group named "${name.trim()}" already exists` }, { status: 409 })
    }
    throw err
  }
})
