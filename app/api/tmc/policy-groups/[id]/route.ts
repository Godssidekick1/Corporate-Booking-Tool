import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { getBandRanksByGroup } from '@/app/lib/rule-engine/linkedPolicyGroups'
import { normaliseBandRanks } from '../route'
import { NextRequest } from 'next/server'

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
// Deletes a shared policy-group template. Blocked while any company is
// still linked to it via company_policy_groups — a shared group in active
// use shouldn't disappear out from under every company relying on it.
// Checks that link table now, not employee_policy_groups (which was the
// old per-employee membership model — groups are linked to companies, not
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

  const auth = await requireTmcPermission(service, user.id, 'manage_policy')
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

  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await service
      .from('policy_groups')
      .update(fields)
      .eq('id', id)

    if (updateError) {
      if (updateError.code === '23505') {
        return Response.json(
          { error: `Another policy group already uses that ${updateError.message.includes('code') ? 'code' : 'name'}` },
          { status: 409 }
        )
      }
      return Response.json({ error: updateError.message }, { status: 500 })
    }
  }

  if (body.bandRanks !== undefined) {
    const desired = normaliseBandRanks(body.bandRanks)
    const current = (await getBandRanksByGroup(service, [id])).get(id) ?? []

    const toAdd = desired.filter(r => !current.includes(r))
    const toRemove = current.filter(r => !desired.includes(r))

    if (toRemove.length > 0) {
      const { error: removeError } = await service
        .from('policy_group_band_ranks')
        .delete()
        .eq('policy_group_id', id)
        .in('band_rank', toRemove)

      if (removeError) {
        return Response.json({ error: removeError.message }, { status: 500 })
      }
    }

    if (toAdd.length > 0) {
      const { error: addError } = await service
        .from('policy_group_band_ranks')
        .insert(toAdd.map(band_rank => ({ policy_group_id: id, band_rank })))

      if (addError) {
        // 23P01 comes from policy_group_band_ranks_no_overlap: this rank is
        // already covered by another group at a company using this one.
        if (addError.code === '23P01') {
          return Response.json({ error: addError.message }, { status: 409 })
        }
        return Response.json({ error: addError.message }, { status: 500 })
      }
    }

    // Rules authored at a rank the group no longer covers are unreachable —
    // resolveEffectivePolicy only looks at ranks in the set. Soft-delete them
    // so the version history stays intact but they stop being served.
    if (toRemove.length > 0) {
      await service
        .from('policy_rules')
        .update({ deleted_at: new Date().toISOString() })
        .eq('policy_group_id', id)
        .in('band_rank', toRemove)
        .is('deleted_at', null)
    }
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

  // No companyId to check anymore — a shared group isn't scoped to one
  // company, so authorization is just "does this caller manage policy for
  // the TMC that owns this group."
  const auth = await requireTmcPermission(service, user.id, 'manage_policy')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (auth.tmcId !== group.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  const { count } = await service
    .from('company_policy_groups')
    .select('company_id', { count: 'exact', head: true })
    .eq('policy_group_id', id)

  if (count && count > 0) {
    return Response.json(
      { error: `${count} compan${count > 1 ? 'ies are' : 'y is'} still linked to "${group.name}". Unlink them before deleting.` },
      { status: 409 }
    )
  }

  // policy_groups FK has ON DELETE CASCADE for policy_rules — deleting the
  // group also removes its rule rows (all versions). This is intentional:
  // an unused group with no companies linked carries no meaningful audit
  // history worth preserving.
  const { error } = await service.from('policy_groups').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}