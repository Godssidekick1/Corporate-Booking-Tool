import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db, transaction } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

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

type Ctx = { params: Promise<{ id: string }> }

// Both verbs need the same three answers: is this a TMC user, may they manage
// this client, and does the client exist under their TMC.
async function authorise(clientId: string) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: Response.json({ error: 'Not authenticated' }, { status: 401 }) }
  }

  const check = await requireTmcPermission(db, user.id, 'manage_clients', clientId)
  if (!check.authorized || !check.tmcId) {
    return { error: Response.json({ error: check.error ?? 'Forbidden' }, { status: check.status ?? 403 }) }
  }
  const tmcId = check.tmcId

  if (!(await clients.statusInTmc(db, clientId, tmcId))) {
    return { error: Response.json({ error: 'Client not found' }, { status: 404 }) }
  }

  return { tmcId, userId: user.id }
}

export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error

  return Response.json({ ok: true, buckets: await clients.bucketsOfClient(db, id) })
})

export const PUT = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const auth = await authorise(id)
  if (auth.error) return auth.error
  const { tmcId, userId } = auth

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
    const owned = await clients.bucketIdsInTmc(db, tmcId, bucketIds)
    if (owned.length !== bucketIds.length) {
      return Response.json({ error: 'Bucket not found for this TMC' }, { status: 422 })
    }
  }

  // Delete-then-insert, together: a failed insert must not leave the client
  // in no buckets at all -- which silently removes every deal code and form of
  // payment that reached them through one.
  await transaction(tx => clients.replaceBucketsOfClient(tx, id, bucketIds), { tenantId: tmcId, userId })

  return Response.json({ ok: true, buckets: await clients.bucketsOfClient(db, id) })
})
