'use client'

import { useMe } from './useMe'

// ── useCanSelfBook ───────────────────────────────────────────────────────────
// Whether the signed-in person may book travel for themselves: false at a
// CBT-only client, whose travel desk books for them (/api/me canSelfBook, the
// rule clientGates.selfBooking enforces on every booking route).
//
// null until known. Callers render booking actions only on `true`, so a CBT
// user never sees a button flash up that the server would then refuse. Reads
// the page's one shared /api/me answer (./useMe).
// ─────────────────────────────────────────────────────────────────────────────

export function useCanSelfBook(): boolean | null {
  const me = useMe()
  if (me === undefined) return null
  // Unreadable: allow, as before; the server still refuses a booking it should.
  return me?.canSelfBook !== false
}
