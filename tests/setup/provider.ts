import { beforeAll } from 'vitest'

// ── The airline provider, unreachable from every test ────────────────────────
// Tests fake the provider (vi.mock of the amadeus client) because its calls
// can create real PNRs. Those mocks spread the real client and replace the
// methods each file uses; a method a file forgot (fareRule, when pricing grew
// a call to it) would otherwise reach the real API with .env.local's keys.
//
// vitest.config.mts points AMADEUS_API_BASE_URL at an unroutable host, and
// here fetch refuses that host outright, so a forgotten mock fails at once
// and loudly rather than calling out or waiting on DNS.
// ─────────────────────────────────────────────────────────────────────────────

export const BLOCKED_PROVIDER_HOST = 'provider.blocked-in-tests.invalid'

beforeAll(() => {
  const realFetch = globalThis.fetch
  if ((realFetch as { providerGuard?: boolean }).providerGuard) return
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes(BLOCKED_PROVIDER_HOST)) {
      throw new Error(`[tests] the airline provider was called for real (${new URL(url).pathname}); mock it`)
    }
    return realFetch(input, init)
  }) as typeof fetch & { providerGuard?: boolean }
  guarded.providerGuard = true
  globalThis.fetch = guarded
})
