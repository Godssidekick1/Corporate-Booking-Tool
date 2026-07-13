import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {

  // ── Verify caller is a logged-in tmc_admin ────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: caller, error: callerError } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (callerError || !caller) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (caller.role !== 'tmc_admin') {
    return Response.json({ error: 'Only TMC admins can create corporate accounts' }, { status: 403 })
  }
  if (!caller.tmc_id) {
    return Response.json({ error: 'TMC context missing' }, { status: 400 })
  }

  // ── Validate body ─────────────────────────────────────────────────────
  const { corporateName, adminEmail, adminName } = await req.json()

  if (!corporateName || !adminEmail || !adminName) {
    return Response.json(
      { error: 'corporateName, adminEmail, and adminName are required' },
      { status: 400 }
    )
  }

  let companyId: string | null = null
  let authUserId: string | null = null

  try {
    // ── Step 1: Create the company ────────────────────────────────────
    // setup_completed defaults to false — the wizard/settings flow flips
    // it once the admin finishes required setup sections.
    const { data: company, error: companyError } = await service
      .from('companies')
      .insert({
        tmc_id: caller.tmc_id,
        name: corporateName,
        status: 'active',
        setup_completed: false,
      })
      .select('id')
      .single()

    if (companyError) throw new Error(companyError.message)
    companyId = company.id

    // ── Step 2: Seed default bands ────────────────────────────────────
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

    // ── Step 3: Invite the corporate admin via Supabase Auth ──────────
    const { data: authData, error: inviteError } =
      await service.auth.admin.inviteUserByEmail(adminEmail, {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/login`,
      })

    if (inviteError) throw new Error(inviteError.message)
    authUserId = authData.user.id

    // ── Step 4: Create the corporate admin employee record ────────────
    // status is 'invited' until they accept the invite and set a password —
    // auth/callback flips this to 'active' on their first successful login.
    const { error: employeeError } = await service.from('employees').insert({
      id: authUserId,
      company_id: companyId,
      tmc_id: null,
      band_id: adminBand.id,
      band_code: adminBand.code,
      band_rank: adminBand.rank,
      full_name: adminName,
      email: adminEmail,
      role: 'admin',
      status: 'invited',
    })

    if (employeeError) throw new Error(employeeError.message)

    return Response.json({
      ok: true,
      companyId,
      message: `"${corporateName}" created. Invite sent to ${adminEmail}.`,
    }, { status: 201 })

  } catch (err) {
    console.error('CREATE CORPORATE ERROR:', err)

    if (authUserId) await service.auth.admin.deleteUser(authUserId)
    if (companyId) await service.from('companies').delete().eq('id', companyId)

    const message = err instanceof Error ? err.message : 'Failed to create corporate'
    return Response.json({ error: message }, { status: 500 })
  }
}