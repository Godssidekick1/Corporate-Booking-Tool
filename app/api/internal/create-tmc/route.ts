import { createServiceClient } from '@/utils/supabase/service'
import { onboardTmc } from '@/app/lib/onboarding/onboardTmc'
import { NextRequest } from 'next/server'

// ── Internal-only route ───────────────────────────────────────────────────────
// Called by Amadeus staff via Postman to onboard a new TMC.
// Not accessible to end users — protected by INTERNAL_API_SECRET header.
//
// KEPT ALONGSIDE /platform ON PURPOSE. The screen is the normal path now, but
// Postman is a fine fallback when a UI is broken or nobody is a platform admin
// yet, and removing this buys nothing. What it no longer has is its own COPY of
// the create-and-roll-back logic — both entry points call onboardTmc, so they
// cannot drift into behaving differently.
//
// Postman usage:
//   POST /api/internal/create-tmc
//   Header: x-internal-secret: <INTERNAL_API_SECRET>
//   Body: {
//     "tmcName": "Corporate Travel Worldwide",
//     "adminEmail": "admin@ctw.com",
//     "adminName": "Sarah Jones"
//   }
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-internal-secret')
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { tmcName, adminEmail, adminName } = await req.json()

  const result = await onboardTmc(createServiceClient(), { tmcName, adminEmail, adminName })

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  return Response.json({
    ok: true,
    tmcId: result.tmcId,
    message: `TMC "${tmcName}" created. Invite sent to ${adminEmail}.`,
  }, { status: 201 })
}
