import { NextResponse, type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { changePassword, MESSAGES } from '@/app/lib/auth/flows'
import * as throttle from '@/app/lib/auth/throttle'
import { requireUser, setSessionCookie } from '@/app/lib/auth/session'
import { requestMeta } from '@/app/lib/auth/request'
import { db } from '@/app/lib/db'
import { openSealed, sealRefusal } from '@/app/lib/auth/sealed'

// ── POST /api/auth/password/change ───────────────────────────────────────────
// Signed in. The current password is required. It was not, on the TMC profile
// page, so a session left open on a shared machine was enough to lock the
// owner out of their account.
//
// Also how an admin-set starting password is replaced (/auth/set-password,
// where proxy.ts sends anyone with must_change_password).
//
// SEALED (2026-11-25): the body is { sealed }, the current and the new
// password sealed together (app/lib/auth/sealed.ts, purpose
// 'change-password'). Plain text is refused. A seal that will not open counts
// against this account's change attempts, like a wrong current password.
//
// Every session of the account ends, and this browser gets a fresh one.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const me = await requireUser()
  const body = await req.json().catch(() => ({}))
  if (body?.currentPassword !== undefined || body?.newPassword !== undefined) {
    return Response.json({ error: 'Please refresh the page and try again.', code: 'NOT_SEALED' }, { status: 400 })
  }
  if (!body?.sealed) {
    return Response.json({ error: 'Enter your current password and a new one.' }, { status: 400 })
  }

  const key = throttle.keys.changeAccount(me.id)
  if (await throttle.limited([{ key, limit: throttle.LIMITS.changePerAccount }])) {
    return Response.json({ error: MESSAGES.tooMany }, { status: 429 })
  }
  const opened = await openSealed(db, body.sealed, 'change-password')
  if (!opened.ok) {
    await throttle.note(key)
    return Response.json({ error: sealRefusal(opened.reason, 'password'), code: 'SEAL_REFUSED' }, { status: 400 })
  }

  const result = await changePassword(me, opened.fields.current, opened.fields.next, requestMeta(req))
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  const res = NextResponse.json({ ok: true })
  setSessionCookie(res, result.token, result.expires)
  return res
})
