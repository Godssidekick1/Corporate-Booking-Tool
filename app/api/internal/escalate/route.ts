import { route } from '@/app/lib/http/handler'
import { db } from '@/app/lib/db'
import { escalateDueApprovals } from '@/app/lib/approval-engine/escalate'
import { NextRequest } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'

// ── POST /api/internal/escalate ──────────────────────────────────────────────
// Passes every approval that has waited past its company's limit to the
// approver's manager (app/lib/approval-engine/escalate.ts). The server sweeps
// on its own timer (escalationTimer.ts, started by instrumentation.ts); this
// is for a manual run, or for a host that schedules it instead
// (ESCALATION_SWEEP=off). Running it more often only finds nothing.
//
//   Header: x-internal-secret: <INTERNAL_API_SECRET>
//
// `npm run escalate` calls it (scripts/escalate.mjs).
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const secret = req.headers.get('x-internal-secret')
  if (!secret || !secretMatches(secret, process.env.INTERNAL_API_SECRET)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const run = await escalateDueApprovals(db)
  return Response.json({ ok: true, ...run })
}, { scope: 'system' })

// Constant-time, as /api/internal/create-tmc: hashed first so the lengths
// match, and an unset secret matches nothing.
function secretMatches(given: string, expected: string | undefined): boolean {
  if (!expected) return false
  const digest = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(given), digest(expected))
}
