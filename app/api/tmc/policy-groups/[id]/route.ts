import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { getBandRanksByGroup } from '@/app/lib/rule-engine/linkedPolicyGroups'
import { normaliseBandRanks } from '../route'
import { withTransaction, orAbort } from '@/app/lib/db/tx'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'

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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: group } = await service
    .from('policy_groups')
    .select('id, tmc_id, name')
    .eq('id', id)
    .maybeSingle()

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

  const fields: Record<string, string | null> = {}
  if (body.name !== undefined) {
    if (!body.name.trim()) {
      return Response.json({ error: 'name cannot be empty' }, { status: 400 })
    }
    fields.name = body.name.trim()
  }
  if (body.code !== undefined) fields.code = body.code?.trim() || null
  if (body.description !== undefined) fields.description = body.description?.trim() || null

  // ── Rename, re-band and soft-delete, atomically ──────────────────────────
  // Four writes across three tables. Without a transaction the dangerous
  // interleaving is: band ranks removed, then the soft-delete of the rules
  // authored at those ranks fails. The group now covers ranks whose rules are
  // still live but unreachable — resolveEffectivePolicy only looks at ranks in
  // the set, so those rules silently stop applying while still appearing in the
  // UI as active policy. That last write did not even check its own error.
  const { error: writeError } = await withTransaction(async (tx) => {
    if (Object.keys(fields).length > 0) {
      await orAbort(tx.from('policy_groups').update(fields).eq('id', id))
    }

    if (body.bandRanks !== undefined) {
      const desired = normaliseBandRanks(body.bandRanks)
      // Read through the transaction, so it sees this transaction's own writes.
      const current = (await getBandRanksByGroup(tx, [id])).get(id) ?? []

      const toAdd = desired.filter(r => !current.includes(r))
      const toRemove = current.filter(r => !desired.includes(r))

      if (toRemove.length > 0) {
        await orAbort(
          tx.from('policy_group_band_ranks')
            .delete()
            .eq('policy_group_id', id)
            .in('band_rank', toRemove)
        )
      }

      if (toAdd.length > 0) {
        await orAbort(
          tx.from('policy_group_band_ranks')
            .insert(toAdd.map(band_rank => ({ policy_group_id: id, band_rank })))
        )
      }

      // Nothing to retire when a rank leaves the set. Rules belong to the
      // GROUP, not to a rank within it (see resolveEffectivePolicy): the
      // remaining ranks keep the same limits. This used to soft-delete rules
      // "at the removed rank" by policy_rules.band_rank -- a column that no
      // longer exists -- so every PATCH that removed a rank failed and rolled
      // back.
    }
  })

  if (writeError) {
    // The two constraint violations that are a user's mistake rather than a
    // fault, mapped to 409 exactly as they were before. Both codes survive the
    // transaction intact, which is the whole reason TxAbort carries the
    // DbError rather than re-deriving one.
    if (writeError.code === '23505') {
      return Response.json(
        { error: `Another policy group already uses that ${writeError.message.includes('code') ? 'code' : 'name'}` },
        { status: 409 }
      )
    }
    // 23P01 comes from policy_group_band_ranks_no_overlap: this rank is
    // already covered by another group at a client using this one.
    if (writeError.code === '23P01') {
      return Response.json({ error: writeError.message }, { status: 409 })
    }
    return Response.json({ error: writeError.message }, { status: 500 })
  }

  const bandRanks = (await getBandRanksByGroup(service, [id])).get(id) ?? []

  const { data: updated } = await service
    .from('policy_groups')
    .select('id, name, code, description, created_at')
    .eq('id', id)
    .single()

  return Response.json({ ok: true, group: { ...updated, bandRanks } })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: group } = await service
    .from('policy_groups')
    .select('id, tmc_id, name')
    .eq('id', id)
    .maybeSingle()

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

  const { count } = await service
    .from('client_policy_groups')
    .select('client_id', { count: 'exact', head: true })
    .eq('policy_group_id', id)

  if (count && count > 0) {
    return Response.json(
      { error: `${count} client${count > 1 ? 's are' : ' is'} still linked to "${group.name}". Unlink them before deleting.` },
      { status: 409 }
    )
  }

  // policy_groups FK has ON DELETE CASCADE for policy_rules — deleting the
  // group also removes its rule rows (all versions). This is intentional:
  // an unused group with no clients linked carries no meaningful audit
  // history worth preserving.
  const { error } = await service.from('policy_groups').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}