import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { companyName, fullName, email, password } = body

  if (!companyName || !fullName || !email || !password) {
    return Response.json(
      { error: 'companyName, fullName, email, and password are required' },
      { status: 400 }
    )
  }

  const supabase = createServiceClient()

  let authUserId: string | null = null
  let companyId: string | null = null

  try {
    // ── Step 1: Create the Supabase Auth user ──────────────────────────
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })

    if (authError) {
      return Response.json({ error: authError.message }, { status: 400 })
    }

    authUserId = authData.user.id

    // ── Step 2: Create the company ────────────────────────────────────
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .insert({ name: companyName, status: 'active' })
      .select('id')
      .single()

    if (companyError) throw new Error(companyError.message)
    companyId = company.id

    // ── Step 3: Seed default bands ─────────────────────────────────────
    const { data: bands, error: bandsError } = await supabase
      .from('bands')
      .insert([
        { company_id: companyId, code: 'L1', label: 'Junior',    rank: 1 },
        { company_id: companyId, code: 'L2', label: 'Associate', rank: 2 },
        { company_id: companyId, code: 'L3', label: 'Senior',    rank: 3 },
        { company_id: companyId, code: 'L4', label: 'Manager',   rank: 4 },
        { company_id: companyId, code: 'L5', label: 'Director',  rank: 5 },
      ])
      .select('id, code, label, rank')

    if (bandsError) throw new Error(bandsError.message)

    const adminBand = bands.find((b) => b.code === 'L5')
    if (!adminBand) throw new Error('Default band seeding failed')

    // ── Step 4: Create the admin employee ─────────────────────────────
    // band_code and band_rank are denormalised from the bands table
    // so dashboard/profile reads don't need a join.
    const { error: employeeError } = await supabase.from('employees').insert({
      id: authUserId,
      company_id: companyId,
      band_id: adminBand.id,
      band_code: adminBand.code,
      band_rank: adminBand.rank,
      full_name: fullName,
      email,
      role: 'admin',
      status: 'active',
    })

    if (employeeError) throw new Error(employeeError.message)

    return Response.json(
      { ok: true, companyId, message: 'Company registered successfully' },
      { status: 201 }
    )
  } catch (err) {
    console.error('REGISTRATION ERROR:', err)

    if (companyId) {
      await supabase.from('companies').delete().eq('id', companyId)
    }
    if (authUserId) {
      await supabase.auth.admin.deleteUser(authUserId)
    }

    const message = err instanceof Error ? err.message : 'Registration failed'
    return Response.json({ error: message }, { status: 500 })
  }
}