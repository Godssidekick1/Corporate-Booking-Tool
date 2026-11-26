import type { NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { requirePlatformAdmin } from '@/app/lib/permissions/requirePlatformAdmin'
import { credentialsProblem, describeProvider, saveProviderCredentials } from '@/app/lib/amadeus/credentials'
import { hasSecretKey, SecretKeyMissing } from '@/app/lib/crypto/secretBox'
import { db } from '@/app/lib/db'
import { onSystem } from '@/app/lib/db/systemScope'
import * as audit from '@/app/lib/repositories/audit'

// ── /api/platform/provider ───────────────────────────────────────────────────
// The flight provider account (Amadeus): base URL, client code, user name and
// password, kept in provider_credentials (user, 2026-11-26), not .env.local.
//
// GET  what is set and by whom. NEVER the password, sealed or not.
// PUT  { baseUrl, clientCode, username, password? } saves them. The password is
//      sealed with PROVIDER_CREDENTIALS_KEY; leave it out to keep the saved one.
//
// PLATFORM ADMIN ONLY (requirePlatformAdmin: 404 to anyone else). Audited.
// ─────────────────────────────────────────────────────────────────────────────

// The one credentials row's id in the audit log (entity_id is a uuid).
const ENTITY_ID = '00000000-0000-0000-0000-00000000a1a1'

export const GET = route(async () => {
  const check = await requirePlatformAdmin()
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })
  return Response.json({ ok: true, provider: await describeProvider(), keySet: hasSecretKey() })
}, { scope: 'system' })

type Body = { baseUrl?: unknown; clientCode?: unknown; username?: unknown; password?: unknown }

export const PUT = route(async (req: NextRequest) => {
  const check = await requirePlatformAdmin()
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })
  if (!hasSecretKey()) {
    return Response.json({ error: new SecretKeyMissing().message, code: 'KEY_MISSING' }, { status: 503 })
  }

  const body = (await req.json().catch(() => ({}))) as Body
  const before = await describeProvider()
  const problem = credentialsProblem(body, before.source !== 'database')
  if (problem) return Response.json({ error: problem }, { status: 400 })

  const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : null
  await saveProviderCredentials({
    baseUrl: String(body.baseUrl).trim(),
    clientCode: String(body.clientCode).trim(),
    username: String(body.username).trim(),
    password,
    updatedBy: check.admin.userId,
  })
  // What changed, never the values of the secrets.
  await audit.append(onSystem(db), {
    action: 'platform.provider_credentials_saved', entityType: 'provider_credentials', entityId: ENTITY_ID,
    userId: check.admin.userId,
    metadata: {
      from: before.source,
      base_url_changed: before.baseUrl !== String(body.baseUrl).trim(),
      username_changed: before.username !== String(body.username).trim(),
      password_changed: password !== null,
    },
  })
  return Response.json({ ok: true, provider: await describeProvider() })
}, { scope: 'system' })
