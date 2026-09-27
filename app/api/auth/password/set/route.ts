import { NextResponse, type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { completeLink } from '@/app/lib/auth/flows'
import { setSessionCookie } from '@/app/lib/auth/session'
import { requestMeta } from '@/app/lib/auth/request'

// ── POST /api/auth/password/set ──────────────────────────────────────────────
// Accept an invite or complete a reset: { token, password } from the link on
// /auth/confirm. Spends the token, sets the password, ends every other
// session, activates an invited employee, and signs this browser in.
//
// The only place a link's token is spent. /auth/confirm renders on GET and
// calls this on a real submit, so an email scanner that opens the link does
// nothing.
//
// The destination is decided here by role. It never comes from the request
// (the old ?next= on this path was an open redirect).
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}))
  const result = await completeLink(body?.token, body?.password, requestMeta(req))

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: result.status })
  }

  const res = NextResponse.json({ ok: true, destination: result.destination })
  setSessionCookie(res, result.token, result.expires)
  return res
})
