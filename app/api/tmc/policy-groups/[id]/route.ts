import { createClient } from '@/utils/supabase/server'
import * as policy from '@/app/lib/repositories/policy'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { normaliseBandRanks, NAME_TAKEN, codeTaken } from '../route'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'

// ── PATCH /api/tmc/policy-groups/[id] ────────────────────────────────────
// Edits a group's identity and, more importantly, the set of band ranks it
// covers. Coverage has to be editable after creation — a TMC discovering a
// client uses rank 7 shouldn't have to rebuild the group and re-author every
// rule.
//
// Rank edits are applied as a diff (insert added, delete removed) rather than
// delete-all-then-reinsert, so an unchanged rank never momentarily disappears.
// That matters because policy_group_band_ranks carries a constraint trigger:
// wiping the set first would let a concurrent booking resolve to
// `no_policy_group` mid-edit.
// ─────────────────────────────────────────────────────────────────────────────

// ── DELETE /api/tmc/policy-groups/[id] ───────────────────────────────────
// Deletes a shared policy-group template. Blocked while any client is
// still linked to it via client_policy_groups — a shared group in active
// use shouldn't disappear out from under every client relying on it.
// Checks that link table now, not employee_policy_groups (which was the
// old per-employee membership model — groups are linked to clients, not
// individual employees, under the Policy Master model).
// ─────────────────────────────────────────────────────────────────────────────

interface UpdateGroupBody {
  name?: string
  code?: string | null
  description?: string | null
  bandRanks?: number[]
}

export const PATCH = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const group = await policy.groupOwner(db, id)

  if (!group) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_policy')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== group.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  const body: UpdateGroupBody = await req.json()

  const fields: policy.GroupEdit = {}
  if (body.name !== undefined) {
    if (!body.name.trim()) {
      return Response.json({ error: 'name cannot be empty' }, { status: 400 })
    }
    fields.name = body.name.trim()
  }
  if (body.code !== undefined) fields.code = body.code?.trim() || null
  if (body.description !== undefined) fields.description = body.description?.trim() || null

  // ── Rename and re-band, atomically ───────────────────────────────────────
  // Writes across two tables. Without a transaction a rename could commit
  // while the rank change beside it is refused, and the admin would see half
  // of what they saved.
  try {
    await transaction(async (tx) => {
      if (Object.keys(fields).length > 0) {
        await policy.updateGroup(tx, id, fields)
      }

      if (body.bandRanks !== undefined) {
        const desired = normaliseBandRanks(body.bandRanks)
        // Read through the transaction, so it sees this transaction's own writes.
        const current = (await policy.bandRanksByGroup(tx, [id])).get(id) ?? []

        await policy.removeRanks(tx, id, current.filter(r => !desired.includes(r)))
        await policy.addRanks(tx, id, desired.filter(r => !current.includes(r)))

        // Nothing to retire when a rank leaves the set. Rules belong to the
        // GROUP, not to a rank within it (see resolveEffectivePolicy): the
        // remaining ranks keep the same limits.
      }
    }, { tenantId: auth.tmcId, userId: user.id })
  } catch (err) {
    // The two constraint violations that are a user's mistake rather than a
    // fault, mapped to 409 exactly as they were before.
    if (codeTaken(err) || isConstraint(err, 'unique', NAME_TAKEN)) {
      return Response.json(
        { error: `Another policy group already uses that ${codeTaken(err) ? 'code' : 'name'}` },
        { status: 409 }
      )
    }
    // An exclusion violation comes from policy_group_band_ranks_no_overlap:
    // this rank is already covered by another group at a client using this
    // one. The trigger's message is written for a person and names both.
    if (isConstraint(err, 'exclusion')) {
      return Response.json({ error: err.message }, { status: 409 })
    }
    throw err
  }

  const [updated, ranks] = await Promise.all([
    policy.group(db, id),
    policy.bandRanksByGroup(db, [id]),
  ])

  return Response.json({ ok: true, group: { ...updated, bandRanks: ranks.get(id) ?? [] } })
})

export const DELETE = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const group = await policy.groupOwner(db, id)

  if (!group) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  // No clientId to check anymore — a shared group isn't scoped to one
  // client, so authorization is just "does this caller manage policy for
  // the TMC that owns this group."
  const auth = await requireTmcPermission(db, user.id, 'manage_policy')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== group.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  const count = (await policy.clientCounts(db, [id])).get(id) ?? 0

  if (count > 0) {
    return Response.json(
      { error: `${count} client${count > 1 ? 's are' : ' is'} still linked to "${group.name}". Unlink them before deleting.` },
      { status: 409 }
    )
  }

  // policy_groups FK has ON DELETE CASCADE for policy_rules — deleting the
  // group also removes its rule rows (all versions). This is intentional:
  // an unused group with no clients linked carries no meaningful audit
  // history worth preserving.
  await policy.deleteGroup(db, id)

  return Response.json({ ok: true })
})
