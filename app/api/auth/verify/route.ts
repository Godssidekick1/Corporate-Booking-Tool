import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/utils/supabase/service'
import { cookies } from 'next/headers'
import { NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

// ── POST /api/auth/verify ────────────────────────────────────────────────
// Does the actual one-time verification (verifyOtp for invite/recovery/
// email-confirm links, exchangeCodeForSession for real PKCE) — only ever
// called from /auth/confirm's button click, never on page load. That's the
// whole point: an automated email-security pre-visit (Outlook Safe Links,
// Google Workspace scanning) hits /auth/callback and /auth/confirm as GET
// requests, which do nothing except render a page. Only a real click POSTs
// here and spends the token.
// ─────────────────────────────────────────────────────────────────────────────

interface VerifyBody {
  tokenHash?: string
  type?: string
  code?: string
  next: string
}

export async function POST(req: NextRequest) {
  const body: VerifyBody = await req.json()
  const { tokenHash, type, code, next } = body

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    })
    if (error) {
      console.error('verifyOtp failed:', error.message)
      return Response.json({
        ok: false,
        error: 'This link has expired or already been used. Ask whoever invited you to send a new one, or use "Forgot password" to request a fresh reset link.',
      }, { status: 400 })
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      console.error('exchangeCodeForSession failed:', error.message)
      return Response.json({
        ok: false,
        error: 'This link has expired or already been used. Please try again or request a new one.',
      }, { status: 400 })
    }
  } else {
    return Response.json({ ok: false, error: 'Invalid confirmation link.' }, { status: 400 })
  }

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return Response.json({ ok: false, error: 'Could not verify your session. Please try again.' }, { status: 400 })
  }

  // Use service client for employee lookup — bypasses RLS which may not be
  // set up for a brand new invited user yet.
  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle()

  // First successful login after an email invite — flip invited -> active.
  // Direct-created employees are already 'active' so this is a no-op for them.
  if (employee?.status === 'invited') {
    await service
      .from('employees')
      .update({ status: 'active' })
      .eq('id', user.id)
  }

  let destination = next && next !== '/' ? next : null

  if (!destination) {
    if (employee?.role === 'tmc_admin' || employee?.role === 'tc') {
      destination = '/tmc/dashboard'
    } else if (employee?.role) {
      destination = '/dashboard'
    } else {
      destination = '/login?error=no_profile'
    }
  }

  return Response.json({ ok: true, destination })
}