import { createServiceClient } from '@/utils/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface OnboardCompanyInput {
  corporateName: string
  adminEmail: string
  adminName: string
  registeredAddress?: string
  gstNumber?: string
  industry?: string
  primaryContactPhone?: string
  size?: string
  bookingMode?: 'sbt' | 'cbt' | 'both'
  client_groupId?: string | null
}

export interface OnboardCompanyResult {
  ok: boolean
  companyId?: string
  error?: string
}

const VALID_SIZES = ['1-50', '51-200', '201-1000', '1001+']
const VALID_BOOKING_MODES = ['sbt', 'cbt', 'both']

// ── onboardCompany ────────────────────────────────────────────────────────────
// Creates a company, seeds default bands, invites the corporate admin.
// Shared by the single-company form and CSV bulk import so both stay in sync —
// never fork this logic between the two entry points.
// ─────────────────────────────────────────────────────────────────────────────

export async function onboardCompany(
  service: ServiceClient,
  tmcId: string,
  appUrl: string,
  input: OnboardCompanyInput
): Promise<OnboardCompanyResult> {
  const { corporateName, adminEmail, adminName } = input

  if (!corporateName?.trim() || !adminEmail?.trim() || !adminName?.trim()) {
    return { ok: false, error: 'corporateName, adminEmail, and adminName are required' }
  }

  if (input.size && !VALID_SIZES.includes(input.size)) {
    return { ok: false, error: `Invalid size: ${input.size}. Must be one of ${VALID_SIZES.join(', ')}` }
  }

  const bookingMode = input.bookingMode ?? 'sbt'
  if (!VALID_BOOKING_MODES.includes(bookingMode)) {
    return { ok: false, error: `Invalid booking_mode: ${bookingMode}` }
  }

  // If a client_groupId was given, confirm it actually belongs to this TMC —
  // prevents cross-tenant assignment via a forged id.
  if (input.client_groupId) {
    const { data: client_group } = await service
      .from('client_groups')
      .select('id')
      .eq('id', input.client_groupId)
      .eq('tmc_id', tmcId)
      .maybeSingle()

    if (!client_group) {
      return { ok: false, error: 'client_group not found for this TMC' }
    }
  }

  let companyId: string | null = null
  let authUserId: string | null = null

  try {
    const { data: company, error: companyError } = await service
      .from('companies')
      .insert({
        tmc_id: tmcId,
        name: corporateName.trim(),
        status: 'active',
        setup_completed: false,
        registered_address: input.registeredAddress?.trim() || null,
        gst_number: input.gstNumber?.trim() || null,
        industry: input.industry?.trim() || null,
        primary_contact_phone: input.primaryContactPhone?.trim() || null,
        size: input.size || null,
        booking_mode: bookingMode,
        client_group_id: input.client_groupId || null,
      })
      .select('id')
      .single()

    if (companyError) {
      console.error('onboardCompany: company insert failed. Raw error:', JSON.stringify(companyError, null, 2))
      throw new Error(companyError.message || companyError.details || companyError.hint || 'company insert failed')
    }
    companyId = company.id

    const { data: bands, error: bandsError } = await service
      .from('bands')
      .insert([
        { company_id: companyId, code: 'L1', label: 'Junior',    rank: 1 },
        { company_id: companyId, code: 'L2', label: 'Associate', rank: 2 },
        { company_id: companyId, code: 'L3', label: 'Senior',    rank: 3 },
        { company_id: companyId, code: 'L4', label: 'Manager',   rank: 4 },
        { company_id: companyId, code: 'L5', label: 'Director',  rank: 5 },
      ])
      .select('id, code, rank')

    if (bandsError) {
      console.error('onboardCompany: bands insert failed. Raw error:', JSON.stringify(bandsError, null, 2))
      throw new Error(bandsError.message || bandsError.details || bandsError.hint || 'bands insert failed')
    }

    const adminBand = bands.find(b => b.code === 'L5')
    if (!adminBand) throw new Error('Band seeding failed')

    // redirectTo points at /auth/callback, not /login — /login is gated by
    // proxy.ts's "authenticated user visiting /login -> redirect to
    // dashboard" rule, which runs server-side before any client page loads,
    // so anyone with an existing session cookie in that browser would get
    // bounced away before this invite was ever processed. /auth/callback is
    // exempt from that redirect and does a proper server-side code
    // exchange; next=/auth/set-password sends them to actually choose a
    // password afterward instead of falling through to a role-based
    // redirect. (Same fix as the other inviteUserByEmail call sites —
    // this one was missed in that pass since it's shared logic, not a
    // route file.)
    const { data: authData, error: inviteError } =
      await service.auth.admin.inviteUserByEmail(adminEmail.trim().toLowerCase(), {
        redirectTo: `${appUrl}/auth/callback?next=/auth/set-password`,
      })

    if (inviteError) {
      console.error('onboardCompany: invite failed. Raw error:', JSON.stringify(inviteError, null, 2))
      throw new Error(inviteError.message || 'invite failed')
    }
    authUserId = authData.user.id

    const { error: employeeError } = await service.from('employees').insert({
      id: authUserId,
      company_id: companyId,
      tmc_id: null,
      band_id: adminBand.id,
      band_code: adminBand.code,
      band_rank: adminBand.rank,
      full_name: adminName.trim(),
      email: adminEmail.trim().toLowerCase(),
      role: 'admin',
      status: 'invited',
    })

    if (employeeError) {
      console.error('onboardCompany: employee insert failed. Raw error:', JSON.stringify(employeeError, null, 2))
      throw new Error(employeeError.message || employeeError.details || employeeError.hint || 'employee insert failed')
    }

    return { ok: true, companyId: companyId! }

  } catch (err) {
    console.error('onboardCompany error:', err)
    if (authUserId) await service.auth.admin.deleteUser(authUserId)
    if (companyId) await service.from('companies').delete().eq('id', companyId)

    const message =
      err instanceof Error ? err.message :
      typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) :
      JSON.stringify(err)
    return { ok: false, error: message || 'Failed to onboard company (no error details available)' }
  }
}