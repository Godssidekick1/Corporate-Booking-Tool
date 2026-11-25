import { NextResponse, type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { signIn, MESSAGES } from '@/app/lib/auth/flows'
import * as throttle from '@/app/lib/auth/throttle'
import { setSessionCookie } from '@/app/lib/auth/session'
import { requestMeta } from '@/app/lib/auth/request'
import { db } from '@/app/lib/db'
import { openSealed, sealRefusal } from '@/app/lib/auth/sealed'

// ── POST /api/auth/signin ────────────────────────────────────────────────────
// Password sign-in. The rules live in app/lib/auth/flows.ts signIn():
//   - throttled per email and per IP (429);
//   - a wrong password and an unknown address get the same 401;
//   - a person whose employee record, client or (for TMC staff) TMC is
//     deactivated is refused with 403, before any session exists.
// On success the session cookie is set on this response.
//
// THE SIGN-IN ARRIVES SEALED (user, 2026-11-19/20; PCI DSS 8.3.2): the email
// and password together, padded to one size and encrypted to a one-off key
// from /api/auth/signin/challenge, opened here once (app/lib/auth/sealed.ts).
// The body is { sealed } and nothing readable. A plain-text password is
// refused, so nothing that logs request bodies ever holds one. A seal that
// cannot be opened (replayed, expired, tampered) counts as a failed attempt
// from that IP, so probing is throttled like guessing.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}))
  const meta = requestMeta(req)
  if (body?.password !== undefined) {
    return Response.json({ error: 'Please refresh the page and sign in again.', code: 'SIGNIN_NOT_SEALED' }, { status: 400 })
  }
  if (!body?.sealed) {
    return Response.json({ error: 'Enter your email and password.', code: 'SIGNIN_MISSING' }, { status: 400 })
  }

  const ipKey = throttle.keys.signinIp(meta.ip)
  if (await throttle.limited([{ key: ipKey, limit: throttle.LIMITS.signinPerIp }])) {
    return Response.json({ error: MESSAGES.tooMany }, { status: 429 })
  }
  const opened = await openSealed(db, body.sealed, 'signin')
  if (!opened.ok) {
    // Every refusal counts, an out-of-date page's too: anything exempt would be
    // a free way to probe. One attempt for a tab left open across a release is
    // nothing; the message tells them to refresh.
    await throttle.note(ipKey)
    return Response.json({
      error: sealRefusal(opened.reason, 'sign-in'),
      code: opened.reason === 'outdated' ? 'SIGNIN_OUTDATED' : 'SIGNIN_EXPIRED',
    }, { status: 400 })
  }
  const result = await signIn(opened.fields.email, opened.fields.password, meta)

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
