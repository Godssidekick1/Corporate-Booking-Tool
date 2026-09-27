import type { NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { requestPasswordReset } from '@/app/lib/auth/flows'
import { requestMeta } from '@/app/lib/auth/request'

// ── POST /api/auth/password/forgot ───────────────────────────────────────────
// "Forgot password" on the sign-in page. The answer is the same whether or not
// the address has an account, so this cannot be used to find out who does.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}))
  const result = await requestPasswordReset(body?.email, requestMeta(req))

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }
  return Response.json({
    ok: true,
    message: 'If that address has an account, a reset link is on its way. It expires in 30 minutes.',
  })
})
