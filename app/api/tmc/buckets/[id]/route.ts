import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { DUPLICATE_BUCKET } from '../route'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import * as fop from '@/app/lib/repositories/fop'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/buckets/[id] ────────────────────────────────────────────────────
// GET     the bucket, its client members, and which deal codes target it
// PATCH   rename / re-describe, or replace the whole membership list
// DELETE  refused while any deal code targets it
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> }

async function authorise(userId: string, id: string) {
  const auth = await requireTmcPermission(db, userId, 'manage_deal_codes')

  if (!auth.authorized || !auth.tmcId) {
    return { ok: false as const, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const bucket = await clients.bucketInTmc(db, id, auth.tmcId)

  if (!bucket) {
    return { ok: false as const, error: 'Bucket not found', status: 404 }
  }

  return { ok: true as const, tmcId: auth.tmcId, bucket }
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

  const [memberIds, dealIds] = await Promise.all([
    clients.memberIds(db, id),
    dealCodes.idsForBucket(db, id),
  ])

  // Which codes this bucket hands out. Read-only here — assignment is edited on
  // the deal, so there is one place that decides reach rather than two that can
  // disagree.
  const [members, deals] = await Promise.all([
    clients.clientsByIds(db, memberIds),
    dealCodes.labels(db, dealIds),
  ])

  return Response.json({
    ok: true,
    bucket: check.bucket,
    clients: members,
    dealCodes: deals,
  })
})

interface UpdateBody {
  name?: string
  code?: string | null
  description?: string | null
  // The complete membership list, not a delta. The editor holds the whole
  // selection, so sending it whole avoids add/remove races between two admins
  // editing the same bucket.
  clientIds?: string[]
}

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
  const body: UpdateBody = await req.json()

  const update: clients.BucketEdit = {}
  if (body.name !== undefined) {
    if (!body.name.trim()) {
      return Response.json({ error: 'Bucket name cannot be empty' }, { status: 400 })
    }
    update.name = body.name.trim()
  }
  if (body.code !== undefined) update.code = body.code?.trim().toUpperCase() || null
  if (body.description !== undefined) update.description = body.description?.trim() || null

  if (Object.keys(update).length > 0) {
    try {
      await clients.updateBucket(db, id, update)
    } catch (err) {
      if (isConstraint(err, 'unique')) return Response.json(DUPLICATE_BUCKET, { status: 409 })
      throw err
    }
  }

  if (body.clientIds !== undefined) {
    const clientIds = body.clientIds

    // Every id checked against this TMC before anything is written: client_id is
    // a plain FK, so another tenant's client would satisfy it and silently join
    // a bucket that hands out negotiated fares.
    if (clientIds.length > 0) {
      const valid = await clients.idsInTmc(db, tmcId, clientIds)
      if (valid.length !== clientIds.length) {
        return Response.json(
          { error: 'One or more of those clients do not belong to your TMC' },
          { status: 422 }
        )
      }
    }

    // Replace wholesale. Delete-then-insert rather than a diff: the list is
    // small, and a diff has more ways to be subtly wrong than this has to be
    // slow. In one transaction, so a failed insert does not leave the bucket
    // empty -- which would silently revoke what it hands out from every member.
    await transaction(tx => clients.replaceMembers(tx, id, clientIds), { tenantId: tmcId, userId: user.id })
  }

  return Response.json({ ok: true })
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

  const { bucket } = check

  // Both assignment tables cascade on bucket_id, so deleting would silently
  // revoke everything this bucket hands out. Refused with the counts instead.
  //
  // Forms of payment were missing from this check until buckets became the only
  // grouping mechanism: deal codes were guarded, FOP mappings were not, and
  // deleting a bucket quietly changed how other clients' tickets got paid for.
  const [dealCount, fopCount] = await Promise.all([
    dealCodes.countForBucket(db, id),
    fop.countForBucket(db, id),
  ])

  const blockers: string[] = []
  if (dealCount > 0) {
    blockers.push(`${dealCount} deal code${dealCount > 1 ? 's' : ''}`)
  }
  if (fopCount > 0) {
    blockers.push(`${fopCount} form${fopCount > 1 ? 's' : ''} of payment`)
  }

  if (blockers.length > 0) {
    return Response.json(
      {
        error: `${blockers.join(' and ')} ${blockers.length === 1 && !blockers[0].includes('s') ? 'is' : 'are'} assigned to "${bucket.name}". Remove those assignments before deleting it.`,
      },
      { status: 409 }
    )
  }

  await clients.deleteBucket(db, id)

  return Response.json({ ok: true })
})
