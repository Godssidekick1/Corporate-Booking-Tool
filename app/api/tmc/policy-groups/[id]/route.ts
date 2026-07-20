import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

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
    .select('id, company_id')
    .eq('id', id)
    .maybeSingle()

  if (!group) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy', group.company_id)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { count } = await service
    .from('employee_policy_groups')
    .select('employee_id', { count: 'exact', head: true })
    .eq('policy_group_id', id)

  if (count && count > 0) {
    return Response.json(
      { error: `${count} employee(s) are still assigned to this group. Reassign them before deleting.` },
      { status: 409 }
    )
  }

  // policy_groups FK has ON DELETE CASCADE for policy_rules — deleting the
  // group also removes its rule rows (all versions). This is intentional:
  // an empty group with no employees carries no meaningful audit history.
  const { error } = await service.from('policy_groups').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}