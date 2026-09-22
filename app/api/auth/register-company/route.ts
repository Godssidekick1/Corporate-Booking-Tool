import { createServiceClient } from '@/utils/supabase/service'
import { DEFAULT_BANDS, mostSeniorBand } from '@/app/lib/onboarding/defaultBands'
import { withTransaction, orAbort } from '@/app/lib/db/tx'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { clientName, fullName, email, password } = body

  if (!clientName || !fullName || !email || !password) {
    return Response.json(
      { error: 'clientName, fullName, email, and password are required' },
      { status: 400 }
    )
  }

  const supabase = createServiceClient()

  // ── Step 1: Create the Supabase Auth user ────────────────────────────────
  // OUTSIDE the transaction, and it has to be. GoTrue is a separate system
  // reached over HTTP; a PostgreSQL transaction cannot roll it back. So this
  // one step keeps a hand-written compensation, and only this one.
  const { data: authData, error: authError } =
    await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

  if (authError) {
    return Response.json({ error: authError.message }, { status: 400 })
  }

  const authUserId = authData.user.id

  // ── Steps 2-4: the whole client, atomically ──────────────────────────────
  // This used to be three separate writes with a compensating
  // `clients.delete()` in a catch block -- which was itself a write that could
  // fail, and which depended on ON DELETE CASCADE reaching bands and employees
  // to avoid orphaning them. A half-registered company is a company that can
  // neither log in nor be registered again, because the email is taken.
  //
  // No SET CONSTRAINTS needed: the clients -> branches -> employees -> clients
  // cycle that pg_dump warns about is not touched here. Nothing creates a
  // branch, so inserting clients before employees satisfies every FK in order.
  const { data: registered, error: writeError } = await withTransaction(async (db) => {
    // Typed explicitly: inside a transaction the client defaults to `unknown[]`
    // rather than the `any[]` the legacy call sites get, so new code has to say
    // what it expects. That is the intended difference, not an inconvenience.
    const client = await orAbort(
      db.from<{ id: string }[]>('clients')
        .insert({ name: clientName, status: 'active' })
        .select('id')
        .single()
    )

    // Self-registration has no TMC to define bands, so it falls back to the
    // shared default ladder. TMC-created clients define their own instead.
    const bands = await orAbort(
      db.from<{ id: string; code: string; label: string; rank: number }[]>('bands')
        .insert(DEFAULT_BANDS.map(b => ({ client_id: client.id, ...b })))
        .select('id, code, label, rank')
    )

    const adminBand = mostSeniorBand(bands)
    if (!adminBand) throw new Error('Default band seeding failed')

    // band_code and band_rank are denormalised from the bands table so
    // dashboard/profile reads don't need a join.
    await orAbort(db.from('employees').insert({
      id: authUserId,
      client_id: client.id,
      band_id: adminBand.id,
      band_code: adminBand.code,
      band_rank: adminBand.rank,
      full_name: fullName,
      email,
      role: 'admin',
      status: 'active',
    }))

    return client.id
  })

  if (writeError) {
    console.error('REGISTRATION ERROR:', writeError)
    // Nothing to undo in the database -- the transaction already did that.
    // The auth user is the only thing left standing, and leaving it would make
    // the email permanently unusable.
    await supabase.auth.admin.deleteUser(authUserId)

    return Response.json({ error: writeError.message }, { status: 500 })
  }

  return Response.json(
    { ok: true, clientId: registered, message: 'Client registered successfully' },
    { status: 201 }
  )
}