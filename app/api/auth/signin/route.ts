import { NextResponse, type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { signIn } from '@/app/lib/auth/flows'
import { setSessionCookie } from '@/app/lib/auth/session'
import { requestMeta } from '@/app/lib/auth/request'
import { db } from '@/app/lib/db'
import { openSealed } from '@/app/lib/auth/sealed'

// ── POST /api/auth/signin ────────────────────────────────────────────────────
// Password sign-in. The rules live in app/lib/auth/flows.ts signIn():
//   - throttled per email and per IP (429);
//   - a wrong password and an unknown address get the same 401;
//   - a person whose employee record, client or (for TMC staff) TMC is
//     deactivated is refused with 403, before any session exists.
// On success the session cookie is set on this response.
//
// THE PASSWORD ARRIVES SEALED (user, 2026-11-19; PCI DSS 8.3.2): encrypted
// to a one-off key from /api/auth/signin/challenge, bound to the email, and
// opened here once (app/lib/auth/sealed.ts). A plain-text password is refused,
// so nothing that logs request bodies ever holds one.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}))
  if (typeof body?.email !== 'string' || !body.email.trim() || !body?.sealed) {
    return Response.json({
      error: body?.password !== undefined
        ? 'Please refresh the page and sign in again.'
        : 'Enter your email and password.',
      code: body?.password !== undefined ? 'SIGNIN_NOT_SEALED' : 'SIGNIN_MISSING',
    }, { status: 400 })
  }
  const opened = await openSealed(db, body.sealed, body.email)
  if (!opened.ok) {
    return Response.json({
      error: opened.reason === 'expired'
        ? 'The sign-in form expired. Please try again.'
        : 'Could not read the sign-in details. Please try again.',
      code: 'SIGNIN_EXPIRED',
    }, { status: 400 })
  }
  const result = await signIn(body.email, opened.secret, requestMeta(req))

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
}, { scope: 'system' })
