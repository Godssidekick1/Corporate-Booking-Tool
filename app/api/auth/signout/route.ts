import { NextResponse, type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { signOut } from '@/app/lib/auth/flows'
import { currentUser, clearSessionCookie } from '@/app/lib/auth/session'
import { requestMeta } from '@/app/lib/auth/request'

// ── POST /api/auth/signout ───────────────────────────────────────────────────
// Ends the session server-side (so the token is dead even if a copy of the
// cookie survives somewhere), clears the cookie, and sends the browser to
// /login. 303 so a form POST becomes a GET. Callers that use fetch pass
// redirect: 'manual' and navigate themselves.
//
// ?reason=idle: the page signed itself out after 10 minutes without input
// (app/components/IdleSignOut.tsx); audited as such, and the login page
// says why.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const me = await currentUser()
  const idle = req.nextUrl.searchParams.get('reason') === 'idle'
  if (me) await signOut(me, requestMeta(req), idle ? 'idle' : 'signed_out')

  const res = NextResponse.redirect(new URL(idle ? '/login?reason=idle' : '/login', req.nextUrl.origin), 303)
  clearSessionCookie(res)
  return res
})
