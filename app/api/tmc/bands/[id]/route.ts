import { createClient } from '@/utils/supabase/server'
import { authoriseBandAccess } from '../route'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── PATCH /api/tmc/bands/[id] ────────────────────────────────────────────────
// Renames a band or moves it to a different rank.
//
// Employees carry denormalised copies of band_code/band_rank, and the
// bands_sync_employees trigger updates them in the same statement. That has to
// happen in the database rather than here: resolveEffectivePolicy looks bands
// up by (client_id, employee.band_code), so an employee left on a stale code
// resolves to `no_band` and stops being policy-checked entirely.
//
// ── DELETE /api/tmc/bands/[id] ───────────────────────────────────────────────
// Removes a band. Blocked while any employee is on it — employees.band_id is
// ON DELETE RESTRICT, and an employee with no band has no policy at all.
// ─────────────────────────────────────────────────────────────────────────────

interface UpdateBandBody {
  code?: string
  label?: string
  rank?: number
}

type Ctx = { params: Promise<{ id: string }> }

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const band = await employees.band(db, id)

  if (!band) {
    return Response.json({ error: 'Band not found' }, { status: 404 })
  }

  const access = await authoriseBandAccess(user.id, band.client_id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const body: UpdateBandBody = await req.json()
  const fields: employees.BandEdit = {}

  if (body.code !== undefined) {
    if (!body.code.trim()) {
      return Response.json({ error: 'code cannot be empty' }, { status: 400 })
    }
    fields.code = body.code.trim()
  }

  if (body.label !== undefined) {
    if (!body.label.trim()) {
      return Response.json({ error: 'label cannot be empty' }, { status: 400 })
    }
    fields.label = body.label.trim()
  }

  if (body.rank !== undefined) {
    if (!Number.isInteger(Number(body.rank)) || Number(body.rank) < 0) {
      return Response.json({ error: 'rank must be a non-negative whole number' }, { status: 400 })
    }

    if (Number(body.rank) !== band.rank) {
      const rankClash = await employees.bandAtRank(db, band.client_id, Number(body.rank), id)

      if (rankClash) {
        return Response.json(
          { error: `Rank ${body.rank} is already used by band "${rankClash.code}". Each band needs its own rank.` },
          { status: 409 }
        )
      }
    }

    fields.rank = Number(body.rank)
  }

  if (Object.keys(fields).length === 0) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 })
  }

  let updated: employees.BandRow
  try {
    updated = await employees.updateBand(db, id, fields)
  } catch (err) {
    if (isConstraint(err, 'unique')) {
      return Response.json(
        { error: `This client already has a band with code "${fields.code}"` },
        { status: 409 }
      )
    }
    throw err
  }

  // Changing a band's rank changes which policy group covers its employees —
  // report it so the caller can warn rather than silently reshuffling policy.
  const rankChanged = fields.rank !== undefined && fields.rank !== band.rank

  return Response.json({ ok: true, band: updated, rankChanged })
})

export const DELETE = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const band = await employees.band(db, id)

  if (!band) {
    return Response.json({ error: 'Band not found' }, { status: 404 })
  }

  const access = await authoriseBandAccess(user.id, band.client_id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Check before relying on the FK so the message names the problem rather
  // than surfacing a raw constraint violation.
  const count = await employees.countOnBandCode(db, band.client_id, band.code)

  if (count > 0) {
    return Response.json(
      { error: `${count} employee${count > 1 ? 's are' : ' is'} on band "${band.code}". Move them to another band before deleting it.` },
      { status: 409 }
    )
  }

  await employees.deleteBand(db, id)

  return Response.json({ ok: true })
})
