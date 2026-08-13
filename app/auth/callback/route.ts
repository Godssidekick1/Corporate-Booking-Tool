import { NextRequest, NextResponse } from 'next/server'

// ── GET /auth/callback ────────────────────────────────────────────────────
// Handles TWO different link shapes, because they come from genuinely
// different Supabase flows:
//
// 1. token_hash + type (invite, recovery, email confirmation) — these are
//    admin-issued or server-issued links (inviteUserByEmail,
//    resetPasswordForEmail), verified with verifyOtp(). This is the shape
//    Supabase's actual default email templates send via {{ .ConfirmationURL }}
//    for these flows — NOT a `code` param. Using exchangeCodeForSession()
//    here was the original bug: that method is for PKCE, which requires a
//    code_verifier stored in the SAME browser that started the flow. Invite
//    and reset links are issued server-side by an admin/TMC action, so the
//    recipient's browser never had a verifier to begin with — the exchange
//    was guaranteed to fail every time, independent of any link-scanner
//    issue. See https://supabase.com/docs/guides/auth/server-side/nextjs
//    (email-based auth section) for Supabase's own documented pattern.
//
// 2. code (real PKCE) — kept for any future flow that genuinely starts in
//    this same browser (e.g. OAuth login), where a verifier does exist.
//
// Email-scanner protection: this route no longer verifies anything itself.
// It only checks the params are present and hands them to /auth/confirm,
// which requires an actual click before verifyOtp/exchangeCodeForSession
// runs. Corporate email security (Outlook Safe Links, Google Workspace
// scanning) auto-visits links server-side before a human ever sees them —
// if THIS route consumed the one-time token_hash/code on that automated
// visit, the real click would always fail with a spent/invalid token. Only
// /auth/confirm's button click may consume it.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  const confirmUrl = new URL('/auth/confirm', req.url)
  confirmUrl.searchParams.set('next', next)

  if (tokenHash && type) {
    confirmUrl.searchParams.set('token_hash', tokenHash)
    confirmUrl.searchParams.set('type', type)
    return NextResponse.redirect(confirmUrl)
  }

  if (code) {
    confirmUrl.searchParams.set('code', code)
    return NextResponse.redirect(confirmUrl)
  }

  return NextResponse.redirect(new URL('/login', req.url))
}