// ── Idle sign-out: the timing ────────────────────────────────────────────────
// Signed out after 10 minutes without a person's input (user, 2026-11-19),
// warned in the last minute. Pure, so it can be tested without a browser;
// app/components/IdleSignOut.tsx keeps the clock and acts on it.
//
// Only a person's input counts (pointer, keys, scrolling, touch), never a
// page's own requests: the confirm page checks for its approval every 8 s, and
// would otherwise keep a session alive for ever. The server signs out at the
// same 10 minutes (app/lib/auth/session.ts IDLE_SECONDS), for a closed tab.
// ─────────────────────────────────────────────────────────────────────────────

export const IDLE_MS = 10 * 60_000
export const WARN_MS = 60_000
// A person active on a page that makes no requests still needs the server's
// clock moved on: at most this often.
export const KEEPALIVE_EVERY_MS = 60_000

// Shared between tabs: input in any tab keeps all of them signed in, and a
// sign-out in one signs out the rest.
export const LAST_ACTIVITY_KEY = 'cbt:lastActivity'
export const SIGNED_OUT_KEY = 'cbt:signedOut'

export type IdlePhase =
  | { phase: 'active' }
  | { phase: 'warning'; secondsLeft: number }
  | { phase: 'expired' }

// Measured in wall-clock time, not by counting ticks: a laptop that slept for
// an hour wakes up already past the limit, and signs out at once.
export function idlePhase(lastActivity: number, now: number): IdlePhase {
  const idle = now - lastActivity
  if (idle >= IDLE_MS) return { phase: 'expired' }
  if (idle >= IDLE_MS - WARN_MS) return { phase: 'warning', secondsLeft: Math.ceil((IDLE_MS - idle) / 1000) }
  return { phase: 'active' }
}

// Whether input now should also tell the server (KEEPALIVE_EVERY_MS apart).
export function keepAliveDue(lastKeepAlive: number, now: number): boolean {
  return now - lastKeepAlive >= KEEPALIVE_EVERY_MS
}
