'use client'

import { useEffect, useState } from 'react'

// ── useCanSelfBook ───────────────────────────────────────────────────────────
// Whether the signed-in person may book travel for themselves: false at a
// CBT-only client, whose travel desk books for them (/api/me canSelfBook, the
// rule clientGates.selfBooking enforces on every booking route).
//
// null until known. Callers render booking actions only on `true`, so a CBT
// user never sees a button flash up that the server would then refuse.
// ─────────────────────────────────────────────────────────────────────────────

export function useCanSelfBook(): boolean | null {
  const [canSelfBook, setCanSelfBook] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/me')
      .then(r => r.json())
      .then(d => { if (!cancelled) setCanSelfBook(d.canSelfBook !== false) })
      .catch(() => { if (!cancelled) setCanSelfBook(true) })
    return () => { cancelled = true }
  }, [])

  return canSelfBook
}
