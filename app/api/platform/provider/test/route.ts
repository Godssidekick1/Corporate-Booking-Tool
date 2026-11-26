import type { NextRequest } from 'next/server'
import { route } from '@/app/lib/http/handler'
import { requirePlatformAdmin } from '@/app/lib/permissions/requirePlatformAdmin'
import { credentialsProblem, savedPassword } from '@/app/lib/amadeus/credentials'
import { tryProviderSignIn } from '@/app/lib/amadeus/client'
import { SecretUnreadable } from '@/app/lib/crypto/secretBox'

// ── POST /api/platform/provider/test ─────────────────────────────────────────
// "Test the connection": signs in to the provider with the credentials as
// typed, before they are saved. No password typed = the saved one. Saves
// nothing and leaves the live session alone. Platform admin only.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest) => {
  const check = await requirePlatformAdmin()
  if (!check.ok) return Response.json({ error: check.error }, { status: check.status })

  const body = await req.json().catch(() => ({}))
  let password: string | null = typeof body?.password === 'string' && body.password ? body.password : null
  if (!password) {
    try { password = await savedPassword() } catch (e) {
      if (e instanceof SecretUnreadable) return Response.json({ ok: false, message: e.message })
      throw e
    }
  }
  const problem = credentialsProblem(body ?? {}, !password)
  if (problem) return Response.json({ error: problem }, { status: 400 })

  const result = await tryProviderSignIn({ baseUrl: String(body.baseUrl).trim(), username: String(body.username).trim(), password: password! })
  return Response.json(result.ok ? { ok: true, message: 'Signed in to the provider. These credentials work.' } : result)
}, { scope: 'system' })
