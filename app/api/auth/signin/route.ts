import { NextResponse, type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { signIn } from '@/app/lib/auth/flows'
import { setSessionCookie } from '@/app/lib/auth/session'
import { requestMeta } from '@/app/lib/auth/request'

// ── POST /api/auth/signin ────────────────────────────────────────────────────
// Password sign-in. The rules live in app/lib/auth/flows.ts signIn():
//   - throttled per email and per IP (429);
//   - a wrong password and an unknown address get the same 401;
//   - a person whose employee record, client or (for TMC staff) TMC is
//     deactivated is refused with 403, before any session exists;
//   - an imported Supabase password hash is upgraded to argon2id.
// On success the session cookie is set on this response.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}))
  const result = await signIn(body?.email, body?.password, requestMeta(req))

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  const res = NextResponse.json({
    ok: true,
    user: { id: result.accountId, email: result.email },
    mustChangePassword: result.mustChangePassword,
    destination: result.mustChangePassword ? '/auth/set-password' : result.destination,
  })
  setSessionCookie(res, result.token, result.expires)
  return res
})
