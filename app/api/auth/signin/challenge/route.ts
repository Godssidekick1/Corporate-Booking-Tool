import { type NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { db } from '@/app/lib/db'
import { createChallenge } from '@/app/lib/auth/sealed'
import { clientIp } from '@/app/lib/auth/request'
import { rateLimited } from '@/app/lib/http/rateLimit'

// ── POST /api/auth/signin/challenge ──────────────────────────────────────────
// A one-off public key to seal the password to, valid two minutes and once
// (app/lib/auth/sealed.ts). Asked for by the sign-in page just before it
// signs in. Counted per IP, so nobody can fill the table.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const limited = await rateLimited('signinChallenge', clientIp(req))
  if (limited) return limited
  return Response.json(await createChallenge(db), { headers: { 'Cache-Control': 'no-store' } })
}, { scope: 'system' })
