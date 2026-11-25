'use client'

import { useEffect, useState } from 'react'

// ── useMe ────────────────────────────────────────────────────────────────────
// The signed-in person (/api/me), asked for ONCE however many components on a
// page want it. My trips used to ask twice (the page, and useCanSelfBook), so
// its admin tabs, header buttons and subtitle each appeared whenever their own
// answer came back: the page visibly assembled itself.
//
// `undefined` while loading, `null` if it could not be read. The answer is
// shared for 30 seconds: long enough for one page and its components, short
// enough that a change of role or of the client's booking mode shows on the
// next page.
// ─────────────────────────────────────────────────────────────────────────────

export interface Me {
  employee?: { id: string; role: string; full_name?: string | null; client_id?: string | null } | null
  canSelfBook?: boolean
  isApprover?: boolean
  [key: string]: unknown
}

const SHARE_MS = 30_000
let shared: { at: number; promise: Promise<Me | null> } | null = null

export function loadMe(): Promise<Me | null> {
  if (shared && Date.now() - shared.at < SHARE_MS) return shared.promise
  const promise = fetch('/api/me')
    .then(r => (r.ok ? r.json() as Promise<Me> : null))
    .catch(() => null)
  shared = { at: Date.now(), promise }
  return promise
}

export function useMe(): Me | null | undefined {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    loadMe().then(m => { if (live) setMe(m) })
    return () => { live = false }
  }, [])
  return me
}
