import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── /api/tmc/buckets/[id] ────────────────────────────────────────────────────
// GET     the bucket, its client members, and which deal codes target it
// PATCH   rename / re-describe, or replace the whole membership list
// DELETE  refused while any deal code targets it
// ─────────────────────────────────────────────────────────────────────────────

async function authorise(userId: string, id: string) {
  const service = createServiceClient()
  const auth = await requireTmcPermission(service, userId, 'manage_deal_codes')

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, service, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const { data: bucket } = await service
    .from('buckets')
    .select('id, tmc_id, name, code, description')
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!bucket) {
    return { ok: false as const, service, error: 'Bucket not found', status: 404 }
  }

  return { ok: true as const, service, tmcId: auth.tmcId, bucket }
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

  const { service, bucket } = check

  const { data: members } = await service
    .from('bucket_clients')
    .select('client_id')
    .eq('bucket_id', id)

  const memberIds = (members ?? []).map(m => m.client_id)

  const [{ data: clients }, { data: assignments }] = await Promise.all([
    memberIds.length
      ? service.from('clients').select('id, name, status').in('id', memberIds).order('name')
      : Promise.resolve({ data: [] }),
    service
      .from('deal_code_assignments')
      .select('deal_code_id')
      .eq('bucket_id', id),
  ])

  const dealIds = (assignments ?? []).map(a => a.deal_code_id)

  // Which codes this bucket hands out. Read-only here — assignment is edited on
  // the deal, so there is one place that decides reach rather than two that can
  // disagree.
  const { data: deals } = dealIds.length
    ? await service
        .from('deal_codes')
        .select('id, code, code_type, airline_code')
        .in('id', dealIds)
        .order('airline_code')
    : { data: [] }

  return Response.json({
    ok: true,
    bucket,
    clients: clients ?? [],
    dealCodes: deals ?? [],
  })
}

interface UpdateBody {
  name?: string
  code?: string | null
  description?: string | null
  // The complete membership list, not a delta. The editor holds the whole
  // selection, so sending it whole avoids add/remove races between two admins
  // editing the same bucket.
  clientIds?: string[]
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
  const body: UpdateBody = await req.json()

  const update: Record<string, unknown> = {}
  if (body.name !== undefined) {
    if (!body.name.trim()) {
      return Response.json({ error: 'Bucket name cannot be empty' }, { status: 400 })
    }
    update.name = body.name.trim()
  }
  if (body.code !== undefined) update.code = body.code?.trim().toUpperCase() || null
  if (body.description !== undefined) update.description = body.description?.trim() || null

  if (Object.keys(update).length > 0) {
    const { error } = await service.from('buckets').update(update).eq('id', id)
    if (error) {
      if (error.code === '23505') {
        return Response.json({ error: 'A bucket with that name already exists' }, { status: 409 })
      }
      return Response.json({ error: error.message }, { status: 500 })
    }
  }

  if (body.clientIds !== undefined) {
    // Every id checked against this TMC before anything is written: client_id is
    // a plain FK, so another tenant's client would satisfy it and silently join
    // a bucket that hands out negotiated fares.
    if (body.clientIds.length > 0) {
      const { data: valid } = await service
        .from('clients')
        .select('id')
        .eq('tmc_id', tmcId)
        .in('id', body.clientIds)

      if ((valid ?? []).length !== body.clientIds.length) {
        return Response.json(
          { error: 'One or more of those clients do not belong to your TMC' },
          { status: 422 }
        )
      }
    }

    // Replace wholesale. Delete-then-insert rather than a diff: the list is
    // small, and a diff has more ways to be subtly wrong than this has to be
    // slow.
    await service.from('bucket_clients').delete().eq('bucket_id', id)

    if (body.clientIds.length > 0) {
      const { error } = await service
        .from('bucket_clients')
        .insert(body.clientIds.map(client_id => ({ bucket_id: id, client_id })))

      if (error) {
        return Response.json({ error: error.message }, { status: 500 })
      }
    }
  }

  return Response.json({ ok: true })
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

  const { service, bucket } = check

  // deal_code_assignments.bucket_id cascades, so deleting would silently revoke
  // every code this bucket hands out. Refused with the count instead.
  const { count } = await service
    .from('deal_code_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('bucket_id', id)

  if (count && count > 0) {
    return Response.json(
      {
        error: `${count} deal code${count > 1 ? 's are' : ' is'} assigned to "${bucket.name}". Remove those assignments before deleting it.`,
      },
      { status: 409 }
    )
  }

  const { error } = await service.from('buckets').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
