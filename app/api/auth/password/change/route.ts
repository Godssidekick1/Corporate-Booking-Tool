import { NextResponse, type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { changePassword } from '@/app/lib/auth/flows'
import { requireUser, setSessionCookie } from '@/app/lib/auth/session'
import { requestMeta } from '@/app/lib/auth/request'

// ── POST /api/auth/password/change ───────────────────────────────────────────
// { currentPassword, newPassword }, signed in. The current password is
// required. It was not, on the TMC profile page, so a session left open on a
// shared machine was enough to lock the owner out of their account.
//
// Also how an admin-set starting password is replaced (/auth/set-password,
// where proxy.ts sends anyone with must_change_password).
//
// Every session of the account ends, and this browser gets a fresh one.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const me = await requireUser()
  const body = await req.json().catch(() => ({}))
  const result = await changePassword(me, body?.currentPassword, body?.newPassword, requestMeta(req))

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  const res = NextResponse.json({ ok: true })
  setSessionCookie(res, result.token, result.expires)
  return res
})
