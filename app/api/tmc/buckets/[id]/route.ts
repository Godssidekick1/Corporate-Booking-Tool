import { requireUser } from '@/app/lib/auth/session'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { DUPLICATE_BUCKET } from '../route'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import * as fop from '@/app/lib/repositories/fop'
import * as commercials from '@/app/lib/repositories/commercials'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/buckets/[id] ────────────────────────────────────────────────────
// GET     the bucket, its client members, and what is assigned through it
//         (deal codes, forms of payment, commercial rules)
// PATCH   rename / re-describe and/or replace the whole membership list
// DELETE  refused while anything is assigned through it
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
  const user = await requireUser()

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const [memberIds, dealIds, fops, rules] = await Promise.all([
    clients.memberIds(db, id),
    dealCodes.idsForBucket(db, id),
    fop.forBucket(db, id),
    commercials.rulesForBucket(db, id),
  ])

  // What this bucket hands out. Read-only here — assignment is edited on the
  // deal code, payment method or rule, so there is one place that decides
  // reach rather than two that can disagree.
  const [members, deals] = await Promise.all([
    clients.clientsByIds(db, memberIds),
    dealCodes.labels(db, dealIds),
  ])

  return Response.json({
    ok: true,
    bucket: check.bucket,
    clients: members,
    dealCodes: deals,
    fops,
    commercialRules: rules,
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
  const user = await requireUser()

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

  let clientIds: string[] | undefined
  if (body.clientIds !== undefined) {
    if (!Array.isArray(body.clientIds)) {
      return Response.json({ error: 'clientIds must be an array' }, { status: 400 })
    }
    clientIds = [...new Set(body.clientIds.filter(Boolean))]

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
  }

  // Details and members in one transaction: the editor saves both at once, and
  // a failed member insert must not leave the bucket empty -- which would
  // silently revoke what it hands out from every member. Members are replaced
  // wholesale (delete-then-insert): the list is small, and a diff has more ways
  // to be subtly wrong than this has to be slow.
  if (Object.keys(update).length === 0 && clientIds === undefined) return Response.json({ ok: true })
  try {
    await transaction(async tx => {
      if (Object.keys(update).length > 0) await clients.updateBucket(tx, id, update)
      if (clientIds !== undefined) await clients.replaceMembers(tx, id, clientIds)
      await clients.touchBuckets(tx, [id], user.id)
    }, { tenantId: tmcId, userId: user.id })
  } catch (err) {
    if (isConstraint(err, 'unique')) return Response.json(DUPLICATE_BUCKET, { status: 409 })
    throw err
  }

  return Response.json({ ok: true })
})

export const DELETE = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = await requireUser()

  const check = await authorise(user.id, id)
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { bucket } = check

  // All three assignment tables cascade on bucket_id, so deleting would
  // silently revoke everything this bucket hands out. Refused with the counts.
  //
  // Forms of payment, then commercial rules, were missing from this check:
  // deleting a bucket quietly changed how other clients' tickets were paid for,
  // and then which markups and fees applied to them.
  const [dealCount, fopCount, ruleCount] = await Promise.all([
    dealCodes.countForBucket(db, id),
    fop.countForBucket(db, id),
    commercials.countForBucket(db, id),
  ])

  const blockers = [
    [dealCount, 'deal code', 'deal codes'],
    [fopCount, 'form of payment', 'forms of payment'],
    [ruleCount, 'commercial rule', 'commercial rules'],
  ] as const
  const named = blockers.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)

  if (named.length > 0) {
    const total = dealCount + fopCount + ruleCount
    const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
    return Response.json(
      { error: `${list} ${total === 1 ? 'is' : 'are'} assigned to "${bucket.name}". Remove those assignments before deleting it.` },
      { status: 409 }
    )
  }

  await clients.deleteBucket(db, id)

  return Response.json({ ok: true })
})
