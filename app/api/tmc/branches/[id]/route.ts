import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { BRANCH_COLUMNS, BRANCH_STATUSES, branchFields, type BranchBody } from '../route'
import { NextRequest } from 'next/server'

// ── /api/tmc/branches/[id] ───────────────────────────────────────────────────
// GET     the branch and the counsellors assigned to it
// PATCH   edit it
// DELETE  refused while anyone still works there
// ─────────────────────────────────────────────────────────────────────────────

async function authorise(userId: string, id: string) {
  const service = createServiceClient()
  const auth = await requireTmcPermission(service, userId, 'manage_branches')

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, service, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const { data: branch } = await service
    .from('branches')
    .select('id, tmc_id, name')
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!branch) {
    return { ok: false as const, service, error: 'Branch not found', status: 404 }
  }

  return { ok: true as const, service, tmcId: auth.tmcId, branch }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service } = check

  const [{ data: branch }, { data: staff }] = await Promise.all([
    service.from('branches').select(BRANCH_COLUMNS).eq('id', id).single(),
    service
      .from('employees')
      .select('id, full_name, email, role, status')
      .eq('branch_id', id)
      .order('full_name'),
  ])

  return Response.json({ ok: true, branch, staff: staff ?? [] })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service, tmcId } = check
  const body: BranchBody = await req.json()

  if (body.name !== undefined && !body.name.trim()) {
    return Response.json({ error: 'Branch name cannot be empty' }, { status: 400 })
  }
  if (body.status && !BRANCH_STATUSES.includes(body.status as typeof BRANCH_STATUSES[number])) {
    return Response.json({ error: `Invalid status: ${body.status}` }, { status: 400 })
  }

  // Promoting a branch demotes the incumbent first. Without this the partial
  // unique index rejects the update, and the admin sees a database constraint
  // rather than the head office moving.
  if (body.is_head_office) {
    await service
      .from('branches')
      .update({ is_head_office: false })
      .eq('tmc_id', tmcId)
      .eq('is_head_office', true)
      .neq('id', id)
  }

  const update: Record<string, unknown> = {
    ...branchFields(body),
    updated_at: new Date().toISOString(),
  }
  if (body.status) update.status = body.status

  const { data: updated, error } = await service
    .from('branches')
    .update(update)
    .eq('id', id)
    .select(BRANCH_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        { error: 'A branch with that name or number already exists' },
        { status: 409 }
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, branch: updated })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { service, branch } = check

  // employees.branch_id is ON DELETE SET NULL, so deleting would silently
  // unassign everyone rather than failing. Refused instead: which branch a
  // counsellor works out of is somebody's decision, not a side effect. Retiring
  // a branch that still has history is what `status: inactive` is for.
  const { count } = await service
    .from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('branch_id', id)

  if (count && count > 0) {
    return Response.json(
      {
        error: `${count} ${count === 1 ? 'person works' : 'people work'} out of "${branch.name}". Move them to another branch first, or set this one inactive to retire it without losing its history.`,
      },
      { status: 409 }
    )
  }

  const { error } = await service.from('branches').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
