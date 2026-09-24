import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── GET /api/tmc/bands?clientId=<uuid> ──────────────────────────────────────
// A client's bands, ordered by rank, with a count of employees on each so an
// admin can see what a rename or delete would touch.
//
// ── POST /api/tmc/bands ──────────────────────────────────────────────────────
// Adds a band. Codes and labels are entirely the client's own vocabulary —
// "L1", "A1", "C", "Band 3" are all fine. Only `rank` is structural: it is the
// client-agnostic integer that policy groups match on, so the same shared
// template applies positionally no matter what a client calls its bands.
//
// Bands used to be hardcoded L1..L5 at client creation with no way to change
// them, which is why the policy model looked more tightly coupled than it is.
// ─────────────────────────────────────────────────────────────────────────────

interface CreateBandBody {
  clientId: string
  code: string
  label: string
  rank: number
}

// Shared by both handlers here and by the [id] route.
export async function authoriseBandAccess(
  userId: string,
  clientId: string
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(db, userId, 'manage_policy', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  // tmc_admin passes the permission check for any clientId, so the tenancy
  // boundary is checked explicitly here.
  const client = await clients.tenancy(db, clientId)

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Client not found for this TMC', status: 404 }
  }

  return { ok: true }
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) {
    return Response.json({ error: 'clientId is required' }, { status: 400 })
  }

  const access = await authoriseBandAccess(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Employee count per band — a rename cascades automatically (see the
  // bands_sync_employees trigger), but a delete is blocked while anyone is on
  // the band, so the count is what tells an admin why.
  const [bands, countByCode] = await Promise.all([
    employees.bandsForClient(db, clientId),
    employees.headcountByBandCode(db, clientId),
  ])

  return Response.json({
    ok: true,
    bands: bands.map(b => ({ ...b, employeeCount: countByCode.get(b.code) ?? 0 })),
  })
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: CreateBandBody = await req.json()
  const { clientId, code, label, rank } = body

  if (!clientId || !code?.trim() || !label?.trim() || rank === undefined || rank === null) {
    return Response.json(
      { error: 'clientId, code, label, and rank are required' },
      { status: 400 }
    )
  }

  if (!Number.isInteger(Number(rank)) || Number(rank) < 0) {
    return Response.json({ error: 'rank must be a non-negative whole number' }, { status: 400 })
  }

  const access = await authoriseBandAccess(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Two bands at the same rank would both match any policy group covering it,
  // which resolveEffectivePolicy can't arbitrate. The DB only enforces
  // uniqueness on (client_id, code), so rank is checked here.
  const rankClash = await employees.bandAtRank(db, clientId, Number(rank))

  if (rankClash) {
    return Response.json(
      { error: `Rank ${rank} is already used by band "${rankClash.code}". Each band needs its own rank.` },
      { status: 409 }
    )
  }

  try {
    const band = await employees.insertBand(db, {
      client_id: clientId,
      code: code.trim(),
      label: label.trim(),
      rank: Number(rank),
    })
    return Response.json({ ok: true, band: { ...band, employeeCount: 0 } }, { status: 201 })
  } catch (err) {
    if (isConstraint(err, 'unique')) {
      return Response.json(
        { error: `This client already has a band with code "${code.trim()}"` },
        { status: 409 }
      )
    }
    throw err
  }
})
