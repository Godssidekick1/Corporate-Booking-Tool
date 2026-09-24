import { createServiceClient } from '@/utils/supabase/service'
import { DEFAULT_BANDS, mostSeniorBand } from '@/app/lib/onboarding/defaultBands'
import { transaction } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'

// ── POST /api/auth/register-company ──────────────────────────────────────────
// A company signs itself up: a client with no TMC, the default band ladder, and
// its first admin, active immediately with the password given here.
//
// UNAUTHENTICATED, and nothing in the app calls it any more -- TMCs onboard
// their clients (/api/tmc/create-corporate/bulk). A client created here belongs
// to no TMC, so no TMC screen can see it. Kept only until someone decides
// whether self-registration is still a product; until then it behaves as it
// always did.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const body = await req.json()
  const { clientName, fullName, email, password } = body

  if (!clientName || !fullName || !email || !password) {
    return Response.json(
      { error: 'clientName, fullName, email, and password are required' },
      { status: 400 }
    )
  }

  const auth = createServiceClient().auth.admin

  // ── Step 1: Create the Supabase Auth user ────────────────────────────────
  // OUTSIDE the transaction, and it has to be. GoTrue is a separate system
  // reached over HTTP; a PostgreSQL transaction cannot roll it back. So this
  // one step keeps a hand-written compensation, and only this one.
  const { data: authData, error: authError } = await auth.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (authError) {
    return Response.json({ error: authError.message }, { status: 400 })
  }

  const authUserId = authData.user.id

  // ── Steps 2-4: the whole client, atomically ──────────────────────────────
  // A half-registered company is a company that can neither log in nor be
  // registered again, because the email is taken.
  try {
    const clientId = await transaction(async (tx) => {
      const { id } = await clients.insertClient(tx, { tmc_id: null, name: clientName })

      // Self-registration has no TMC to define bands, so it falls back to the
      // shared default ladder. TMC-created clients define their own instead.
      const bands = await employees.insertBands(tx, id, DEFAULT_BANDS)

      const adminBand = mostSeniorBand(bands)
      if (!adminBand) throw new Error('Default band seeding failed')

      await employees.insertClientAdmin(tx, {
        id: authUserId,
        client_id: id,
        band: adminBand,
        full_name: fullName,
        email,
        status: 'active',
        onboarding_method: 'self_register',
      })

      return id
    }, { userId: authUserId })

    return Response.json(
      { ok: true, clientId, message: 'Client registered successfully' },
      { status: 201 }
    )
  } catch (err) {
    console.error('REGISTRATION ERROR:', err)
    // Nothing to undo in the database -- the transaction already did that.
    // The auth user is the only thing left standing, and leaving it would make
    // the email permanently unusable.
    await auth.deleteUser(authUserId)

    return Response.json({ error: 'Registration failed. Nothing was saved — please try again.' }, { status: 500 })
  }
})
