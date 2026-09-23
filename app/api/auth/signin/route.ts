import { createClient } from '@/utils/supabase/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { NextRequest } from 'next/server'

// ── POST /api/auth/signin ────────────────────────────────────────────────────
// Password sign-in, plus one check that happens AFTER Supabase accepts the
// credentials: whether the person's client company is still in service.
//
// Deactivating a client is how a client is removed in this product (there is no
// delete — their bookings are financial records). That has to stop their people
// signing in, or "removed" means nothing more than a grey badge on a list.
//
// Checked here rather than in proxy.ts on purpose. proxy.ts runs on every page
// request, and adding a clients lookup to it would put a database round trip in
// front of every navigation in the app to catch a condition that changes maybe
// twice in a client's lifetime. Sign-in is where access is granted, so sign-in
// is where it is refused.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const { email, password } = await req.json()

  if (!email || !password) {
    return Response.json(
      { error: 'email and password are required' },
      { status: 400 }
    )
  }

  const supabase = await createClient()

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return Response.json({ error: error.message }, { status: 401 })
  }

  // TMC staff carry client_id null and are unaffected — this only ever blocks
  // people who belong TO a client. A read failure lets them through: the whole
  // clientGates module fails open for the same reason, and locking a company out
  // of its travel tool over a database blip is the worse mistake.
  //
  // One LEFT JOIN. The two separate reads that used to be here existed because
  // PostgREST typed a to-one embed as an array; SQL has no such problem.
  //
  // The repository THROWS on a database failure, so the fail-open described
  // above is now an explicit catch rather than a discarded error.
  let standing: employees.ClientStanding | null = null
  try {
    standing = await employees.clientStanding(db, data.user.id)
  } catch (err) {
    console.error('[signin] client standing check failed; letting the sign-in through', err)
  }

  if (standing?.client_id && standing.client_status === 'inactive') {
    // Sign back out before answering. Without this the cookie set by
    // signInWithPassword above stays on the response and the browser is left
    // holding a valid session for an account we have just refused — every
    // subsequent request would sail past proxy.ts.
    await supabase.auth.signOut()
    return Response.json(
      { error: 'This account is no longer active. Please contact your travel desk.' },
      { status: 403 }
    )
  }

  return Response.json({
    ok: true,
    user: {
      id: data.user.id,
      email: data.user.email,
    },
  })
})
