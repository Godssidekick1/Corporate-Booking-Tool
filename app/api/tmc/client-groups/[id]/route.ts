import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import {
  normaliseClientGroup,
  validateClientGroup,
  duplicateCode,
  type ClientGroupBody,
} from '../route'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

type Ctx = { params: Promise<{ id: string }> }

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_client_groups')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (!(await clients.groupInTmc(db, id, auth.tmcId))) {
    return Response.json({ error: 'Client group not found' }, { status: 404 })
  }

  const body: ClientGroupBody = await req.json()

  const validationError = validateClientGroup(body)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  // Normalised through the shared helper rather than a second copy of the same
  // rules, which is how POST and PATCH drift apart.
  const update = normaliseClientGroup(body)
  if (body.name !== undefined) update.name = body.name.trim()

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  try {
    const clientGroup = await clients.updateGroup(db, id, update)
    return Response.json({ ok: true, clientGroup })
  } catch (err) {
    if (isConstraint(err, 'unique')) return duplicateCode(body.group_code)
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

  const auth = await requireTmcPermission(db, user.id, 'manage_client_groups')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  if (!(await clients.groupInTmc(db, id, auth.tmcId))) {
    return Response.json({ error: 'Client group not found' }, { status: 404 })
  }

  // Clients with this client_group_id get set to null on delete (schema
  // default: ON DELETE SET NULL) — they're not deleted, just unassigned.
  await clients.deleteGroup(db, id)

  return Response.json({ ok: true })
})
