// ── The signed-in pages ──────────────────────────────────────────────────────
// Keep this an explicit allow-list. A new page is NOT protected until it is
// added here (its data still is, by its API routes). Read by the page gate
// (proxy.ts) and the idle sign-out (app/components/IdleSignOut.tsx), so the
// two can never disagree about which pages need a session.
// ─────────────────────────────────────────────────────────────────────────────

export const PROTECTED = ['/dashboard', '/settings', '/tmc', '/book', '/bookings', '/approvals', '/reports', '/profile', '/platform', '/trips', '/organization']

// Exact-or-child-segment match: /book/flights matches /book, /bookmark does not.
export function matchesBase(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(base + '/')
}

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED.some(base => matchesBase(pathname, base))
}
