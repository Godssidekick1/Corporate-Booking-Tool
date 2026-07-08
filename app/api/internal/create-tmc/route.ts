import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── Internal-only route ───────────────────────────────────────────────────────
// Called by Amadeus staff via Postman to onboard a new TMC.
// Not accessible to end users — protected by INTERNAL_API_SECRET header.
//
// Postman usage:
//   POST /api/internal/create-tmc
//   Header: x-internal-secret: <INTERNAL_API_SECRET>
//   Body: {
//     "tmcName": "Corporate Travel Worldwide",
//     "adminEmail": "admin@ctw.com",
//     "adminName": "Sarah Jones"
//   }
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Verify internal secret
  const secret = req.headers.get('x-internal-secret')
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { tmcName, adminEmail, adminName } = await req.json()

  if (!tmcName || !adminEmail || !adminName) {
    return Response.json(
      { error: 'tmcName, adminEmail, and adminName are required' },
      { status: 400 }
    )
  }

  const service = createServiceClient()

  let tmcId: string | null = null
  let authUserId: string | null = null

  try {
    // ── Step 1: Create the TMC record ─────────────────────────────────
    const { data: tmc, error: tmcError } = await service
      .from('tmcs')
      .insert({ name: tmcName, status: 'active' })
      .select('id')
      .single()

    if (tmcError) throw new Error(tmcError.message)
    tmcId = tmc.id

    // ── Step 2: Invite the TMC admin via Supabase Auth ────────────────
    // This sends an invite email with a link to set their password.
    // The link redirects to /tmc/dashboard after password is set.
    const { data: authData, error: inviteError } =
      await service.auth.admin.inviteUserByEmail(adminEmail, {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      })

    if (inviteError) throw new Error(inviteError.message)
    authUserId = authData.user.id

    // ── Step 3: Create the TMC admin employee record ──────────────────
    // tmc_id is set, company_id is null — TMC admins are not attached
    // to a specific corporate client.
    const { error: employeeError } = await service.from('employees').insert({
      id: authUserId,
      tmc_id: tmcId,
      company_id: null,
      full_name: adminName,
      email: adminEmail,
      role: 'tmc_admin',
      status: 'active',
    })

    if (employeeError) throw new Error(employeeError.message)

    return Response.json({
      ok: true,
      tmcId,
      message: `TMC "${tmcName}" created. Invite sent to ${adminEmail}.`,
    }, { status: 201 })

  } catch (err) {
    console.error('CREATE TMC ERROR:', err)

    // Rollback in reverse order
    if (authUserId) {
      await service.auth.admin.deleteUser(authUserId)
    }
    if (tmcId) {
      await service.from('tmcs').delete().eq('id', tmcId)
    }

    const message = err instanceof Error ? err.message : 'Failed to create TMC'
    return Response.json({ error: message }, { status: 500 })
  }
}