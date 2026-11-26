import { db } from '@/app/lib/db'
import * as credentialsRepo from '@/app/lib/repositories/providerCredentials'
import { open, seal } from '@/app/lib/crypto/secretBox'
import { clearCachedSession } from './sessionStore'

// ── Where the flight provider's credentials come from ────────────────────────
// The provider_credentials row, set by a platform admin in the platform console
// (user, 2026-11-26: "store the AIR API credentials as a table in the db and
// not env"). The password is sealed there and opened here, in memory only.
//
// Until a row exists, the old AMADEUS_* environment variables are used, with a
// warning in the log, so a deployment keeps working until someone enters the
// credentials in the console. Once a row exists the environment is ignored,
// and the AMADEUS_* lines should be deleted from it.
//
// Held for a minute per process: every provider call needs them, and a
// database round trip each time would cost more than the call's own setup.
// Saving new credentials clears this cache and the provider session.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderCredentials {
  baseUrl: string
  clientCode: string
  username: string
  password: string
  source: 'database' | 'environment'
}

export const PASSWORD_PURPOSE = 'provider_credentials:password'
const HOLD_MS = 60_000

let held: { at: number; creds: ProviderCredentials } | null = null
let warned = false

function fromEnvironment(): ProviderCredentials | null {
  const baseUrl = (process.env.AMADEUS_API_BASE_URL ?? '').trim().replace(/\/$/, '')
  const clientCode = (process.env.AMADEUS_CLIENT_CODE ?? '').trim()
  const username = (process.env.AMADEUS_USERNAME ?? '').trim()
  const password = (process.env.AMADEUS_PASSWORD ?? '').trim()
  if (!baseUrl || !username) return null
  return { baseUrl, clientCode, username, password, source: 'environment' }
}

export class ProviderNotConfigured extends Error {
  constructor() {
    super('The flight provider is not set up. A platform admin enters its credentials in the platform console (Flight provider).')
    this.name = 'ProviderNotConfigured'
  }
}

export async function providerCredentials(): Promise<ProviderCredentials> {
  if (held && Date.now() - held.at < HOLD_MS) return held.creds
  const row = await credentialsRepo.current(db)
  let creds: ProviderCredentials | null = null
  if (row) {
    creds = {
      baseUrl: row.base_url.replace(/\/$/, ''),
      clientCode: row.client_code,
      username: row.username,
      password: open(row.password_sealed, PASSWORD_PURPOSE),
      source: 'database',
    }
  } else {
    creds = fromEnvironment()
    if (creds && !warned) {
      warned = true
      console.warn('[amadeus] using AMADEUS_* from the environment: no credentials saved yet. Enter them in the platform console (Flight provider), then delete those lines.')
    }
  }
  if (!creds) throw new ProviderNotConfigured()
  held = { at: Date.now(), creds }
  return creds
}

// What the platform console shows: everything but the password.
export async function describeProvider(): Promise<{
  source: 'database' | 'environment' | 'none'
  baseUrl: string | null; clientCode: string | null; username: string | null
  passwordSet: boolean; updatedAt: string | null; updatedBy: string | null
}> {
  const row = await credentialsRepo.current(db)
  if (row) {
    return {
      source: 'database', baseUrl: row.base_url, clientCode: row.client_code, username: row.username,
      passwordSet: true, updatedAt: row.updated_at, updatedBy: row.updated_by_email,
    }
  }
  const env = fromEnvironment()
  return env
    ? { source: 'environment', baseUrl: env.baseUrl, clientCode: env.clientCode, username: env.username, passwordSet: !!env.password, updatedAt: null, updatedBy: null }
    : { source: 'none', baseUrl: null, clientCode: null, username: null, passwordSet: false, updatedAt: null, updatedBy: null }
}

// Saves new credentials. `password` null keeps the saved one (only allowed
// when one is saved). Clears the cache and the provider session, so the next
// call signs in with the new account.
export async function saveProviderCredentials(input: {
  baseUrl: string; clientCode: string; username: string; password: string | null; updatedBy: string
}): Promise<void> {
  let passwordSealed: string
  if (input.password !== null) {
    passwordSealed = seal(input.password, PASSWORD_PURPOSE)
  } else {
    const row = await credentialsRepo.current(db)
    if (!row) throw new Error('A password is required the first time.')
    passwordSealed = row.password_sealed
  }
  await credentialsRepo.save(db, { ...input, baseUrl: input.baseUrl.replace(/\/$/, ''), passwordSealed })
  forgetProviderCredentials()
  await clearCachedSession()
}

// Checked before anything is saved or tested; each message says what to fix.
export function credentialsProblem(
  b: { baseUrl?: unknown; clientCode?: unknown; username?: unknown; password?: unknown },
  passwordRequired: boolean,
): string | null {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const baseUrl = text(b.baseUrl)
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return 'Enter the base URL, starting with https:// (for example https://api.example.com/v1).'
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)) {
    return 'The base URL must use https://: the password is sent to it.'
  }
  if (!text(b.clientCode) || text(b.clientCode).length > 64) return 'Enter the client code (up to 64 characters).'
  if (!text(b.username) || text(b.username).length > 128) return 'Enter the user name (up to 128 characters).'
  if (b.password !== undefined && b.password !== null && typeof b.password !== 'string') return 'The password must be text.'
  if (passwordRequired && !text(b.password)) return 'Enter the password: none is saved yet.'
  if (typeof b.password === 'string' && b.password.length > 256) return 'The password is too long (up to 256 characters).'
  return null
}

export function forgetProviderCredentials(): void {
  held = null
}

// The password currently saved, opened: for "test the connection" with only
// some fields changed. Null when none is saved.
export async function savedPassword(): Promise<string | null> {
  const row = await credentialsRepo.current(db)
  return row ? open(row.password_sealed, PASSWORD_PURPOSE) : null
}
