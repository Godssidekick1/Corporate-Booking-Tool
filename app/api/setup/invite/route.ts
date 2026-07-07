import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

const VALID_ROLES = ['employee', 'manager', 'finance', 'admin'] as const
type ValidRole = typeof VALID_ROLES[number]

interface InviteRow {
  email: string
  role: string
  band: string
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body = await req.json()
  const { invites } = body

  if (!invites || !Array.isArray(invites) || invites.length === 0) {
    return Response.json({ error: 'No invites provided' }, { status: 400 })
  }

  const service = createServiceClient()

  // ── Look up the admin employee record ──────────────────────────────────────
  // If this returns nothing, it means /api/setup/company did not insert the
  // admin into the employees table. Fix that route — see schema notes.
  const { data: employee, error: empError } = await service
    .from('employees')
    .select('company_id, role')
    .eq('id', user.id)
    .single()

  if (empError || !employee) {
    // Provide a clear diagnostic instead of the generic 404
    return Response.json(
      {
        error:
          'Your admin employee record was not found. ' +
          'This usually means company setup did not complete correctly. ' +
          'Please contact support or re-run setup.',
        code: 'ADMIN_EMPLOYEE_MISSING',
      },
      { status: 404 }
    )
  }

  if (employee.role !== 'admin') {
    return Response.json({ error: 'Only admins can send invites' }, { status: 403 })
  }

  const companyId = employee.company_id

  // ── Load bands for this tenant ─────────────────────────────────────────────
  const { data: bands, error: bandsError } = await service
    .from('bands')
    .select('id, code, rank')
    .eq('company_id', companyId)

  if (bandsError) {
    return Response.json({ error: 'Could not load bands' }, { status: 500 })
  }

  if (!bands || bands.length === 0) {
    return Response.json(
      {
        error: 'No bands configured for this company. Complete policy setup first.',
        code: 'BANDS_NOT_CONFIGURED',
      },
      { status: 422 }
    )
  }

  const bandMap = Object.fromEntries(
    bands.map(b => [b.code, { id: b.id, code: b.code, rank: b.rank }])
  )

  // ── Process each invite ────────────────────────────────────────────────────
  const results: {
    email: string
    status: 'sent' | 'skipped' | 'failed'
    error?: string
  }[] = []

  for (const invite of invites as InviteRow[]) {
    const email = invite.email.trim().toLowerCase()

    // Validate email shape
    if (!email || !email.includes('@') || !email.includes('.')) {
      results.push({ email, status: 'failed', error: 'Invalid email address' })
      continue
    }

    // Validate role
    const normalizedRole = invite.role.toLowerCase() as ValidRole
    if (!VALID_ROLES.includes(normalizedRole)) {
      results.push({ email, status: 'failed', error: `Invalid role: ${invite.role}` })
      continue
    }

    // Validate band
    const band = bandMap[invite.band]
    if (!band) {
      results.push({ email, status: 'failed', error: `Unknown band: ${invite.band}` })
      continue
    }

    // ── Check for duplicate in this tenant ──────────────────────────────────
    const { data: existing } = await service
      .from('employees')
      .select('id, status')
      .eq('company_id', companyId)
      .eq('email', email)
      .maybeSingle()

    if (existing) {
      results.push({
        email,
        status: 'skipped',
        error: `Already exists in this company (status: ${existing.status})`,
      })
      continue
    }

    // ── Send Supabase Auth invite ────────────────────────────────────────────
    const { data: authData, error: inviteError } = await service.auth.admin.inviteUserByEmail(
      email,
      {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/register`,
        data: {
          // These land in user_metadata on the new auth user.
          // The employee can update their full_name on first login.
          company_id: companyId,
          role: normalizedRole,
          band_code: band.code,
        },
      }
    )

    if (inviteError) {
      // Supabase returns a 422 if the user already exists in auth.users
      // (possibly from a different tenant). Surface this clearly.
      results.push({ email, status: 'failed', error: inviteError.message })
      continue
    }

    // ── Pre-create the employee row ──────────────────────────────────────────
    // This row exists before the user accepts the invite so their
    // band and role are ready the moment they first sign in.
    const { error: employeeError } = await service.from('employees').insert({
      id: authData.user.id,
      company_id: companyId,
      band_id: band.id,
      band_code: band.code,
      band_rank: band.rank,
      email,
      full_name: email.split('@')[0], // placeholder until they complete their profile
      role: normalizedRole,
      status: 'invited',             // not 'active' until they accept + set password
      invited_by: user.id,
      invited_at: new Date().toISOString(),
    })

    if (employeeError) {
      // Auth user was created but employee row failed — roll back the auth user
      // so they don't end up in a broken half-created state.
      await service.auth.admin.deleteUser(authData.user.id)
      results.push({ email, status: 'failed', error: employeeError.message })
      continue
    }

    results.push({ email, status: 'sent' })
  }

  const sent    = results.filter(r => r.status === 'sent').length
  const skipped = results.filter(r => r.status === 'skipped').length
  const failed  = results.filter(r => r.status === 'failed').length

  return Response.json({ ok: true, sent, skipped, failed, results })
}