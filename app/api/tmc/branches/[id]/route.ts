import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { BRANCH_STATUSES, DUPLICATE_BRANCH, branchFields, type BranchBody } from '../route'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
import * as tmcs from '@/app/lib/repositories/tmcs'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/branches/[id] ───────────────────────────────────────────────────
// GET     the branch and the counsellors assigned to it
// PATCH   edit it
// DELETE  refused while anyone still works there
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> }

async function authorise(userId: string, id: string) {
  const auth = await requireTmcPermission(db, userId, 'manage_branches')

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const branch = await tmcs.branchInTmc(db, id, auth.tmcId)

  if (!branch) {
    return { ok: false as const, error: 'Branch not found', status: 404 }
  }

  return { ok: true as const, tmcId: auth.tmcId, branch }
}

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
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

  const [branch, staff] = await Promise.all([
    tmcs.branch(db, id),
    employees.staffAtBranch(db, id),
  ])

  return Response.json({ ok: true, branch, staff })
})

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
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

  const { tmcId } = check
  const body: BranchBody = await req.json()

  if (body.name !== undefined && !body.name.trim()) {
    return Response.json({ error: 'Branch name cannot be empty' }, { status: 400 })
  }
  if (body.status && !BRANCH_STATUSES.includes(body.status as typeof BRANCH_STATUSES[number])) {
    return Response.json({ error: `Invalid status: ${body.status}` }, { status: 400 })
  }

  const fields: tmcs.BranchFields = { ...branchFields(body) }
  if (body.status) fields.status = body.status

  try {
    const updated = await transaction(async tx => {
      // Promoting a branch demotes the incumbent first, or the partial unique
      // index rejects the update. Together, so a failed update does not leave
      // the TMC with no head office.
      if (body.is_head_office) await tmcs.demoteHeadOffice(tx, tmcId, id)
      return tmcs.updateBranch(tx, id, fields)
    }, { tenantId: tmcId, userId: user.id })

    return Response.json({ ok: true, branch: updated })
  } catch (err) {
    if (isConstraint(err, 'unique')) return Response.json(DUPLICATE_BRANCH, { status: 409 })
    throw err
  }
})

export const DELETE = route(async (req: NextRequest, { params }: Ctx) => {
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

  const { branch } = check

  // employees.branch_id is ON DELETE SET NULL, so deleting would silently
  // unassign everyone rather than failing. Refused instead: which branch a
  // counsellor works out of is somebody's decision, not a side effect. Retiring
  // a branch that still has history is what `status: inactive` is for.
  const count = await employees.countAtBranch(db, id)

  if (count > 0) {
    return Response.json(
      {
        error: `${count} ${count === 1 ? 'person works' : 'people work'} out of "${branch.name}". Move them to another branch first, or set this one inactive to retire it without losing its history.`,
      },
      { status: 409 }
    )
  }

  await tmcs.deleteBranch(db, id)

  return Response.json({ ok: true })
})
