import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

interface UpdateClientGroupBody {
  name?: string
  city?: string
  country?: string
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

  const body: UpdateClientGroupBody = await req.json()
  const update: Record<string, string> = {}

  if (body.name !== undefined) {
    if (!body.name.trim()) {
      return Response.json({ error: 'Client group name cannot be empty' }, { status: 400 })
    }
    update.name = body.name.trim()
  }
  if (body.city !== undefined) update.city = body.city.trim()
  if (body.country !== undefined) update.country = body.country.trim()

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data: clientGroup, error } = await service
    .from('client_groups')
    .update(update)
    .eq('id', id)
    .select('id, name, city, country, created_at')
    .single()

  if (error) {
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

  // Companies with this client_group_id get set to null on delete (schema
  // default: ON DELETE SET NULL) — they're not deleted, just unassigned.
  const { error } = await service.from('client_groups').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}