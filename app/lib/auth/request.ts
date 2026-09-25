import type { NextRequest } from 'next/server'
import type { RequestMeta } from './session'

// ── Facts about the request, for sessions, throttling and the audit log ──────

// The client's IP. Behind a proxy (Vercel, IIS with ARR, nginx) the socket
// address is the proxy's, and the client's is the first X-Forwarded-For
// entry, which that proxy sets. DEPLOYMENT REQUIREMENT: the app must only be
// reachable through such a proxy, or a client can send its own
// X-Forwarded-For and pick the IP it is throttled under. The per-email limits
// do not depend on this.
export function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || req.headers.get('x-real-ip') || null
}

export function requestMeta(req: NextRequest): RequestMeta {
  return { ip: clientIp(req), userAgent: req.headers.get('user-agent') }
}

// The application's own address, for links in emails. From configuration and
// NEVER from the request: a Host header is attacker-controlled, and a reset
// link built from it can point at the attacker's site.
export function appUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
  if (configured) return configured
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000'
  throw new Error('[auth] NEXT_PUBLIC_APP_URL must be set: it is the address used in invite and reset links')
}

// ?next= and similar: accepted only as a path on this site. "//evil.com" and
// "/\evil.com" are read by browsers as other hosts, so a leading "/" alone is
// not enough.
export function safeLocalPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null
  if (/[\u0000-\u001f\\]/.test(raw)) return null
  return raw
}
