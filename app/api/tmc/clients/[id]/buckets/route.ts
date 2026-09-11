import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET / PUT /api/tmc/clients/[id]/buckets ──────────────────────────────────
// Which buckets this client belongs to, edited from the client's own screen.
//
// The same membership the buckets master edits, pivoted. Buckets are how deal
// codes and forms of payment reach a client — stampBooking and stampFop both
// expand client → buckets at booking time — so being able to change it while
// configuring a corporate is the difference between one pass and four.
//
// WHY PUT THE WHOLE LIST rather than POST/DELETE one at a time: the bucket-side
// route already replaces wholesale, and two screens doing read-modify-write on
// the same rows will eventually drop an edit made between one screen's read and
// its write. Sending the intended end state has no such window.
// ─────────────────────────────────────────────────────────────────────────────

interface Body {
  bucketIds?: string[]
}

// Both verbs need the same three answers: is this a TMC user, may they manage
// this client, and does the client exist under their TMC.
async function authorise(clientId: string) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: Response.json({ error: 'Not authenticated' }, { status: 401 }) }
  }

  const service = createServiceClient()
  const check = await requireTmcPermission(service, user.id, 'manage_clients', clientId)
  if (!check.authorized || !check.tmcId) {
    return { error: Response.json({ error: check.error ?? 'Forbidden' }, { status: check.status ?? 403 }) }
  }
  const tmcId = check.tmcId

  const { data: client } = await service
    .from('clients')
    .select('id, tmc_id')
    .eq('id', clientId)
    .eq('tmc_id', tmcId)
    .maybeSingle()

  if (!client) {
    return { error: Response.json({ error: 'Client not found' }, { status: 404 }) }
  }

  return { service, tmcId }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error
  const { service } = auth

  const { data: rows, error } = await service
    .from('bucket_clients')
    .select('bucket_id, buckets ( id, name, code )')
    .eq('client_id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const buckets = (rows ?? [])
    .map(r => r.buckets)
    .filter(Boolean)
    .flat()

  return Response.json({ ok: true, buckets })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error
  const { service, tmcId } = auth

  let body: Body
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!Array.isArray(body.bucketIds)) {
    return Response.json({ error: 'bucketIds must be an array' }, { status: 400 })
  }

  const bucketIds = [...new Set(body.bucketIds.filter(Boolean))]

  // Every bucket checked against this TMC before anything is written. These are
  // plain foreign keys, so another tenant's bucket id would satisfy the
  // constraint perfectly well and quietly attach their curated client set to
  // this client's commercial arrangement.
  if (bucketIds.length > 0) {
    const { data: owned } = await service
      .from('buckets')
      .select('id')
      .eq('tmc_id', tmcId)
      .in('id', bucketIds)

    if ((owned?.length ?? 0) !== bucketIds.length) {
      return Response.json({ error: 'Bucket not found for this TMC' }, { status: 422 })
    }
  }

  const { error: clearError } = await service
    .from('bucket_clients')
    .delete()
    .eq('client_id', id)

  if (clearError) {
    return Response.json({ error: clearError.message }, { status: 500 })
  }

  if (bucketIds.length > 0) {
    const { error: insertError } = await service
      .from('bucket_clients')
      .insert(bucketIds.map(bucket_id => ({ bucket_id, client_id: id })))

    if (insertError) {
      return Response.json({ error: insertError.message }, { status: 500 })
    }
  }

  const { data: rows } = await service
    .from('bucket_clients')
    .select('bucket_id, buckets ( id, name, code )')
    .eq('client_id', id)

  const buckets = (rows ?? []).map(r => r.buckets).filter(Boolean).flat()

  return Response.json({ ok: true, buckets })
}
