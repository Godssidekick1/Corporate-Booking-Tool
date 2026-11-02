import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Security headers ─────────────────────────────────────────────────────────
// next.config sends these on every response. Held here so a header removed
// (or a framing rule loosened) fails the suite, not a scanner after deploy.
// ─────────────────────────────────────────────────────────────────────────────

async function load(env: string) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', env)
  const mod = await import('../../next.config')
  const rules = await mod.default.headers!()
  return { config: mod.default, rules, headers: Object.fromEntries(rules[0].headers.map(h => [h.key, h.value])) }
}

describe('security headers', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('every page refuses framing, sniffing, foreign form posts and plugins', async () => {
    const { config, rules, headers } = await load('development')
    expect(rules).toHaveLength(1)
    expect(rules[0].source).toBe('/:path*')
    expect(config.poweredByHeader).toBe(false)
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['Content-Security-Policy']).toBe(
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'")
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=(), payment=()')
    // Plain HTTP in development: no HSTS, or localhost would be pinned to HTTPS.
    expect(headers['Strict-Transport-Security']).toBeUndefined()
  })

  it('production adds HSTS for this host only', async () => {
    const { headers } = await load('production')
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000')
  })
})
