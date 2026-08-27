import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { authoriseCompany } from '../route'
import { NextRequest } from 'next/server'

// ── PATCH /api/tmc/traveler-profiles/[id] ────────────────────────────────────
// Edits one employee's corporate record and travel profile from the TMC side.
//
// Covers the fields a travel desk actually maintains on someone's behalf:
// their band, cost centre, department, designation, and the passport/contact
// details a booking needs. Role and status are NOT here — those are account
// permissions, and they stay with the corporate admin on /settings/users.
//
// traveler_profile is merged, not replaced. The employee edits the same jsonb
// on /profile, so a TMC saving the corporate half would otherwise wipe whatever
// the traveller had filled in themselves.
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors TravelerProfile in app/lib/book/types.ts. Listed explicitly rather
// than spreading the request body, so a caller cannot write arbitrary keys into
// the jsonb.
const PROFILE_FIELDS = [
  'title', 'gender', 'dateOfBirth',
  'passportNumber', 'issuingCountry', 'nationality', 'passportExpiryDate',
  'mealPreference',
  'email', 'mobile', 'address', 'city', 'state', 'zipCode',
] as const

interface UpdateBody {
  band?: string
  costCentre?: string | null
  department?: string | null
  designation?: string | null
  fullName?: string
  profile?: Record<string, unknown>
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

  const { data: target } = await service
    .from('employees')
    .select('id, company_id, traveler_profile')
    .eq('id', id)
    .maybeSingle()

  if (!target?.company_id) {
    return Response.json({ error: 'Employee not found' }, { status: 404 })
  }

  const access = await authoriseCompany(service, user.id, target.company_id)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const body: UpdateBody = await req.json()
  const update: Record<string, unknown> = {}

  if (body.fullName !== undefined) {
    if (!body.fullName.trim()) {
      return Response.json({ error: 'Name cannot be empty' }, { status: 400 })
    }
    update.full_name = body.fullName.trim()
  }

  if (body.department !== undefined) update.department = body.department?.trim() || null
  if (body.designation !== undefined) update.designation = body.designation?.trim() || null

  if (body.costCentre !== undefined) {
    const code = body.costCentre?.trim() || null

    // Checked against the client's own list so a typo doesn't silently create a
    // cost centre that exists on exactly one person and matches nothing in a report.
    if (code) {
      const { data: centre } = await service
        .from('cost_centres')
        .select('code')
        .eq('company_id', target.company_id)
        .eq('code', code)
        .maybeSingle()

      if (!centre) {
        return Response.json({
          error: `"${code}" is not one of this client's cost centres. Add it under Cost centres first.`,
        }, { status: 422 })
      }
    }

    update.cost_centre = code
  }

  if (body.band !== undefined) {
    const { data: bandRow } = await service
      .from('bands')
      .select('id, code, rank')
      .eq('company_id', target.company_id)
      .eq('code', body.band)
      .maybeSingle()

    if (!bandRow) {
      return Response.json(
        { error: `Band "${body.band}" is not configured for this client` },
        { status: 422 }
      )
    }

    // band_code and band_rank are denormalised alongside band_id the same way
    // every other writer sets them, so policy resolution stays consistent.
    update.band_id = bandRow.id
    update.band_code = bandRow.code
    update.band_rank = bandRow.rank
  }

  if (body.profile !== undefined) {
    const existing = (target.traveler_profile as Record<string, unknown> | null) ?? {}
    const incoming: Record<string, unknown> = {}

    for (const field of PROFILE_FIELDS) {
      if (body.profile[field] === undefined) continue
      const value = body.profile[field]
      incoming[field] = typeof value === 'string' ? value.trim() : value
    }

    update.traveler_profile = { ...existing, ...incoming }
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data: updated, error } = await service
    .from('employees')
    .update(update)
    .eq('id', id)
    .select('id, full_name, email, band_code, band_rank, department, cost_centre, designation, traveler_profile')
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, employee: updated })
}
