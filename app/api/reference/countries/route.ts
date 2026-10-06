import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as reference from '@/app/lib/repositories/reference'
import { route } from '@/app/lib/http/handler'

// ── GET /api/reference/countries ─────────────────────────────────────────────
// Every country (about 250), for nationality, passport issuing country and
// address pickers. Small enough to send whole and filter in the browser.
// Authenticated, not permission-gated: like airlines, a fact about the world.
// Data: GeoNames (CC BY 4.0).
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  await requireUser()
  return Response.json({ ok: true, countries: await reference.listCountries(db) })
})
