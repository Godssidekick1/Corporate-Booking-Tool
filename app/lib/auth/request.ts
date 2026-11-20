import type { NextRequest } from 'next/server'
import type { RequestMeta } from './session'

// ── Facts about the request, for sessions, throttling and the audit log ──────

// ── The client's IP, as the proxy saw it ─────────────────────────────────────
// DEPLOYMENT REQUIREMENT: the app is reachable only through the proxy (it
// listens on localhost, docs/deploy-windows.md), so the last entry is always
// the proxy's own. (Vercel replaces the header with the one address it saw:
// first and last are the same there.) The per-email limits do not depend on
// any of this.
//
// Behind a reverse proxy (IIS with ARR, docs/deploy-windows.md) the proxy
// APPENDS the address it saw to X-Forwarded-For. Everything before that came
// from the client and can be anything: reading the first entry (as this did)
// let anyone send "X-Forwarded-For: <random>" and look like a new IP on every
// sign-in attempt, slipping past the per-IP throttles. So the address is read
// from the right, TRUSTED_PROXY_HOPS entries in (default 1: one proxy, ours).
// ─────────────────────────────────────────────────────────────────────────────

export function clientIp(req: NextRequest): string | null {
  const hops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS) || 1)
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const fromProxy = chain.length >= hops ? chain[chain.length - hops] : null
  return fromProxy || req.headers.get('x-real-ip') || null
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
