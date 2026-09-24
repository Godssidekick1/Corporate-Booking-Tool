import { requirePlatformAdmin } from '@/app/lib/permissions/requirePlatformAdmin'
import { onboardTmc } from '@/app/lib/onboarding/onboardTmc'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as tmcs from '@/app/lib/repositories/tmcs'
import { route } from '@/app/lib/http/handler'

// ── /api/platform/tmcs ───────────────────────────────────────────────────────
// GET   every TMC on the platform, with its client, staff and admin counts
// POST  create one and invite its first admin
//
// PLATFORM ADMIN ONLY. This is the surface that creates tenants, so it sits
// above every tenant role — see requirePlatformAdmin for why that is a separate
// table rather than a value on employees.role.
//
// The counts come back with the page in one query (tmcs.platformList). They
// used to be three count queries per TMC on the page.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (req: NextRequest) => {
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const { rows, total } = await tmcs.platformList(db, params.search, params)

  return Response.json(pagedResponse(rows, total, params))
})

export const POST = route(async (req: NextRequest) => {
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const { tmcName, adminEmail, adminName } = await req.json()

  // Same implementation the Postman route calls. The create-and-roll-back
  // sequence lives in one place precisely so these two cannot diverge.
  const result = await onboardTmc({ tmcName, adminEmail, adminName })

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  return Response.json({
    ok: true,
    tmcId: result.tmcId,
    message: `"${tmcName}" created. Invite sent to ${adminEmail}.`,
  }, { status: 201 })
})
