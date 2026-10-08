import { requireUser } from '@/app/lib/auth/session'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import * as fop from '@/app/lib/repositories/fop'
import * as commercials from '@/app/lib/repositories/commercials'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/buckets ─────────────────────────────────────────────────────────
// A bucket is a curated set of CLIENTS.
//
// Deliberately not the same thing as a client group. A client group is the org
// hierarchy a client belongs to — a fact about the client. A bucket is a
// distribution decision someone made on purpose ("Tier 1 corporates", "North
// India desk"), cuts across groups, and exists to be targeted by masters.
//
// Deal codes, forms of payment and commercial rules all target buckets.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser()

  const auth = await requireTmcPermission(db, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []
  // ?usedBy=deal_codes|fops|commercials|none -- what assigns something through it.
  const usedBy = req.nextUrl.searchParams.get('usedBy')
  const use = (clients.BUCKET_USES as readonly string[]).includes(usedBy ?? '') ? usedBy as clients.BucketUse : null

  const { rows, total } = await clients.bucketsForTmc(
    db,
    auth.tmcId,
    ids.length > 0 ? { ids } : { search: params.search, page: params, usedBy: use }
  )

  const bucketIds = rows.map(b => b.id)

  // What reaches clients through each bucket. Shown so the consequence of
  // adding a client to it is legible before you do it.
  const [clientCount, preview, dealCount, fopCount, ruleCount] = await Promise.all([
    clients.memberCounts(db, bucketIds),
    clients.memberPreview(db, bucketIds),
    dealCodes.countByBucket(db, bucketIds),
    fop.countByBucket(db, bucketIds),
    commercials.countByBucket(db, bucketIds),
  ])

  return Response.json(
    pagedResponse(
      rows.map(b => ({
        ...b,
        clientCount: clientCount.get(b.id) ?? 0,
        memberPreview: preview.get(b.id) ?? [],
        dealCodeCount: dealCount.get(b.id) ?? 0,
        fopCount: fopCount.get(b.id) ?? 0,
        ruleCount: ruleCount.get(b.id) ?? 0,
      })),
      total,
      params
    )
  )
})

interface CreateBody {
  name: string
  code?: string | null
  description?: string | null
}

export const DUPLICATE_BUCKET = { error: 'A bucket with that name already exists' }

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser()

  const auth = await requireTmcPermission(db, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: CreateBody = await req.json()

  if (!body.name?.trim()) {
    return Response.json({ error: 'Bucket name is required' }, { status: 400 })
  }

  try {
    const created = await clients.insertBucket(db, {
      tmc_id: auth.tmcId,
      name: body.name.trim(),
      code: body.code?.trim().toUpperCase() || null,
      description: body.description?.trim() || null,
      created_by: user.id,
    })
    return Response.json({
      ok: true,
      bucket: { ...created, clientCount: 0, memberPreview: [], dealCodeCount: 0, fopCount: 0, ruleCount: 0 },
    })
  } catch (err) {
    if (isConstraint(err, 'unique')) return Response.json(DUPLICATE_BUCKET, { status: 409 })
    throw err
  }
})
