import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'
import type { TravelerProfile } from '@/app/lib/book/types'

// ── GET / PATCH /api/employees/me ─────────────────────────────────────────────
// Self-service profile endpoint — an employee reading/writing their OWN
// traveler_profile only. Not a general employee-management route (that's
// /api/employees, TMC/admin-facing); this is scoped to employees.id === the
// caller's auth user id (same convention as every other /api/book/* route),
// no company_id/role checks needed since it can never touch another row.
//
// GET returns the current profile (null if never filled in) plus
// first_login_completed, so /profile can decide whether to show a
// "welcome, let's set up your profile" framing vs. a normal edit form.
//
// PATCH validates the shape server-side (not just trusting the client) since
// this feeds directly into AddPassengerDetails later — a malformed
// traveler_profile wouldn't surface as an error until someone tries to book,
// which is a much worse place to catch it. Also sets first_login_completed
// to true on first successful save, closing the loop the proxy's redirect
// depends on.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const { data: employee, error } = await service
    .from('employees')
    .select('id, full_name, email, traveler_profile, first_login_completed')
    .eq('id', user.id)
    .maybeSingle()

  if (error || !employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  return Response.json({
    ok: true,
    fullName: employee.full_name,
    email: employee.email,
    travelerProfile: employee.traveler_profile as TravelerProfile | null,
    firstLoginCompleted: employee.first_login_completed,
  })
}

const VALID_TITLES = ['MR', 'MRS', 'MS', 'MSTR', 'MISS']
const VALID_GENDERS = ['Male', 'Female']
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/  // DD/MM/YYYY, matches PassengerDetail's expected format

function validateTravelerProfile(body: unknown): { profile?: TravelerProfile; error?: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid request body' }
  const b = body as Record<string, unknown>

  if (typeof b.title !== 'string' || !VALID_TITLES.includes(b.title)) {
    return { error: `title must be one of ${VALID_TITLES.join(', ')}` }
  }
  if (typeof b.gender !== 'string' || !VALID_GENDERS.includes(b.gender)) {
    return { error: `gender must be one of ${VALID_GENDERS.join(', ')}` }
  }
  if (typeof b.dateOfBirth !== 'string' || !DATE_RE.test(b.dateOfBirth)) {
    return { error: 'dateOfBirth must be in DD/MM/YYYY format' }
  }

  // Passport fields are optional as a set, but if any one is provided the
  // others should be too — a passport number with no expiry date isn't
  // useful data to have saved.
  const passportFields = ['passportNumber', 'issuingCountry', 'nationality', 'passportExpiryDate'] as const
  const providedPassportFields = passportFields.filter(f => b[f])
  if (providedPassportFields.length > 0 && providedPassportFields.length < passportFields.length) {
    return { error: 'If any passport field is provided, all of passportNumber, issuingCountry, nationality, and passportExpiryDate are required' }
  }
  if (b.passportExpiryDate && (typeof b.passportExpiryDate !== 'string' || !DATE_RE.test(b.passportExpiryDate))) {
    return { error: 'passportExpiryDate must be in DD/MM/YYYY format' }
  }

  return {
    profile: {
      title: b.title,
      gender: b.gender,
      dateOfBirth: b.dateOfBirth,
      passportNumber: (b.passportNumber as string) || undefined,
      issuingCountry: (b.issuingCountry as string) || undefined,
      nationality: (b.nationality as string) || undefined,
      passportExpiryDate: (b.passportExpiryDate as string) || undefined,
      mealPreference: b.mealPreference as 'Non-Veg' | 'Veg' | 'Vegan' | 'Eggetarian' | undefined,
    },
  }
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body = await req.json()
  const { profile, error: validationError } = validateTravelerProfile(body)

  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  const service = createServiceClient()
  const { data: updated, error } = await service
    .from('employees')
    .update({
      traveler_profile: profile,
      first_login_completed: true,
    })
    .eq('id', user.id)
    .select('id, traveler_profile, first_login_completed')
    .maybeSingle()

  if (error || !updated) {
    console.error('Traveler profile update error:', error)
    return Response.json({ error: 'Could not save your profile' }, { status: 500 })
  }

  return Response.json({
    ok: true,
    travelerProfile: updated.traveler_profile,
    firstLoginCompleted: updated.first_login_completed,
  })
}