import { route } from '@/app/lib/http/handler'
import { requireUser, IDLE_SECONDS } from '@/app/lib/auth/session'

// ── POST /api/auth/keepalive ─────────────────────────────────────────────────
// A person is reading or typing without the page making requests: this keeps
// their session's idle clock (10 minutes) in step with the page's. Looking the
// session up is what extends it (app/lib/auth/session.ts). Sent at most once a
// minute, and only after real input (app/components/IdleSignOut.tsx); 401 once
// the session has ended, and the page then signs out.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async () => {
  await requireUser()
  return Response.json({ ok: true, idleSeconds: IDLE_SECONDS }, { headers: { 'Cache-Control': 'no-store' } })
})
