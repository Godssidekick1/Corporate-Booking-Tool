import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── DELETE /api/tmc/policy-groups/[id] ───────────────────────────────────
// Deletes a shared policy-group template. Blocked while any company is
// still linked to it via company_policy_groups — a shared group in active
// use shouldn't disappear out from under every company relying on it.
// Checks that link table now, not employee_policy_groups (which was the
// old per-employee membership model — groups are linked to companies, not
// individual employees, under the Policy Master model).
// ─────────────────────────────────────────────────────────────────────────────

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