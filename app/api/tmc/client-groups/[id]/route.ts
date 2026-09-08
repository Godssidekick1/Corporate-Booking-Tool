import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import {
  CLIENT_GROUP_COLUMNS,
  normaliseClientGroup,
  validateClientGroup,
  type ClientGroupBody,
} from '../route'
import { NextRequest } from 'next/server'

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

  const auth = await requireTmcPermission(service, user.id, 'manage_client_groups')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: existing } = await service
    .from('client_groups')
    .select('id')
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!existing) {
    return Response.json({ error: 'Client group not found' }, { status: 404 })
  }

  const body: ClientGroupBody = await req.json()

  const validationError = validateClientGroup(body)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  // Normalised through the shared helper rather than a second copy of the same
  // rules, which is how POST and PATCH drift apart.
  const update: Record<string, string | null> = normaliseClientGroup(body)
  if (body.name !== undefined) update.name = body.name.trim()

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data: clientGroup, error } = await service
    .from('client_groups')
    .update(update)
    .eq('id', id)
    .select(CLIENT_GROUP_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        { error: `Group code "${body.group_code}" is already used by another group.` },
        { status: 409 }
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, clientGroup })
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

  const auth = await requireTmcPermission(service, user.id, 'manage_client_groups')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: existing } = await service
    .from('client_groups')
    .select('id')
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!existing) {
    return Response.json({ error: 'Client group not found' }, { status: 404 })
  }

  // Clients with this client_group_id get set to null on delete (schema
  // default: ON DELETE SET NULL) — they're not deleted, just unassigned.
  const { error } = await service.from('client_groups').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}