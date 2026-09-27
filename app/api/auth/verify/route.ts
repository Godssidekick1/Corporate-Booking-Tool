import type { NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { inspectLink } from '@/app/lib/auth/flows'
import { requestMeta } from '@/app/lib/auth/request'

// ── POST /api/auth/verify ────────────────────────────────────────────────────
// Is this invite/reset link still good, and whose account is it for? Answers
// without spending the token, so /auth/confirm can show the address and a
// password form, or say the link is dead, before the person types anything.
//
// POST, with the token in the body, because the token must never appear in a
// URL a server logs. The link carries it in the fragment, which only the
// browser sees.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}))
  const result = await inspectLink(body?.token, requestMeta(req))

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: result.status })
  }
  return Response.json({ ok: true, email: result.email, purpose: result.purpose })
})
