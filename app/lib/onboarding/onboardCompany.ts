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
      })
      .select('id')
      .single()

    if (companyError) throw new Error(companyError.message)
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

    if (bandsError) throw new Error(bandsError.message)

    const adminBand = bands.find(b => b.code === 'L5')
    if (!adminBand) throw new Error('Band seeding failed')

    const { data: authData, error: inviteError } =
      await service.auth.admin.inviteUserByEmail(adminEmail.trim().toLowerCase(), {
        redirectTo: `${appUrl}/login`,
      })

    if (inviteError) throw new Error(inviteError.message)
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

    if (employeeError) throw new Error(employeeError.message)

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