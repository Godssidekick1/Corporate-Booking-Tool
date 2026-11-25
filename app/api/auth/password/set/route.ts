import { NextResponse, type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { completeLink, MESSAGES } from '@/app/lib/auth/flows'
import * as throttle from '@/app/lib/auth/throttle'
import { setSessionCookie } from '@/app/lib/auth/session'
import { requestMeta } from '@/app/lib/auth/request'
import { db } from '@/app/lib/db'
import { openSealed, sealRefusal } from '@/app/lib/auth/sealed'

// ── POST /api/auth/password/set ──────────────────────────────────────────────
// Accept an invite or complete a reset, from the link on /auth/confirm. Spends
// the token, sets the password, ends every other session, activates an invited
// employee, and signs this browser in.
//
// The only place a link's token is spent. /auth/confirm renders on GET and
// calls this on a real submit, so an email scanner that opens the link does
// nothing.
//
// SEALED (2026-11-25): the body is { sealed }, the link's token and the new
// password sealed together (app/lib/auth/sealed.ts, purpose 'set-password').
// The token is sealed too: when a password is refused (too weak) the token is
// not spent, so a logged plain body would hand the account to whoever read
// the log. Plain text is refused. A seal that will not open counts against
// the IP like a bad link.
//
// The destination is decided here by role. It never comes from the request
// (the old ?next= on this path was an open redirect).
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}))
  const meta = requestMeta(req)
  if (body?.password !== undefined || body?.token !== undefined) {
    return Response.json({ ok: false, error: 'Please refresh the page and try again.', code: 'NOT_SEALED' }, { status: 400 })
  }
  if (!body?.sealed) {
    return Response.json({ ok: false, error: 'Choose a password.' }, { status: 400 })
  }

  const ipKey = throttle.keys.linkIp(meta.ip)
  if (await throttle.limited([{ key: ipKey, limit: throttle.LIMITS.linkPerIp }])) {
    return Response.json({ ok: false, error: MESSAGES.tooMany }, { status: 429 })
  }
  const opened = await openSealed(db, body.sealed, 'set-password')
  if (!opened.ok) {
    await throttle.note(ipKey)
    return Response.json({ ok: false, error: sealRefusal(opened.reason, 'password'), code: 'SEAL_REFUSED' }, { status: 400 })
  }

  const result = await completeLink(opened.fields.token, opened.fields.password, meta)
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: result.status })
  }

  const res = NextResponse.json({ ok: true, destination: result.destination })
  setSessionCookie(res, result.token, result.expires)
  return res
}, { scope: 'system' })
