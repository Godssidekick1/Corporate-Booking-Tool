import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { authoriseBandAccess } from '../route'
import { NextRequest } from 'next/server'

// ── PATCH /api/tmc/bands/[id] ────────────────────────────────────────────────
// Renames a band or moves it to a different rank.
//
// Employees carry denormalised copies of band_code/band_rank, and the
// bands_sync_employees trigger updates them in the same statement. That has to
// happen in the database rather than here: resolveEffectivePolicy looks bands
// up by (company_id, employee.band_code), so an employee left on a stale code
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

async function loadBand(service: ReturnType<typeof createServiceClient>, id: string) {
  const { data } = await service
    .from('bands')
    .select('id, company_id, code, label, rank')
    .eq('id', id)
    .maybeSingle()
  return data
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
  const band = await loadBand(service, id)

  if (!band) {
    return Response.json({ error: 'Band not found' }, { status: 404 })
  }

  const access = await authoriseBandAccess(service, user.id, band.company_id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const body: UpdateBandBody = await req.json()
  const fields: Record<string, string | number> = {}

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
      const { data: rankClash } = await service
        .from('bands')
        .select('code')
        .eq('company_id', band.company_id)
        .eq('rank', Number(body.rank))
        .neq('id', id)
        .maybeSingle()

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

  const { data: updated, error } = await service
    .from('bands')
    .update(fields)
    .eq('id', id)
    .select('id, code, label, rank')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        { error: `This company already has a band with code "${fields.code}"` },
        { status: 409 }
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Changing a band's rank changes which policy group covers its employees —
  // report it so the caller can warn rather than silently reshuffling policy.
  const rankChanged = fields.rank !== undefined && fields.rank !== band.rank

  return Response.json({ ok: true, band: updated, rankChanged })
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
  const band = await loadBand(service, id)

  if (!band) {
    return Response.json({ error: 'Band not found' }, { status: 404 })
  }

  const access = await authoriseBandAccess(service, user.id, band.company_id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Check before relying on the FK so the message names the problem rather
  // than surfacing a raw constraint violation.
  const { count } = await service
    .from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', band.company_id)
    .eq('band_code', band.code)

  if (count && count > 0) {
    return Response.json(
      { error: `${count} employee${count > 1 ? 's are' : ' is'} on band "${band.code}". Move them to another band before deleting it.` },
      { status: 409 }
    )
  }

  const { error } = await service.from('bands').delete().eq('id', id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
