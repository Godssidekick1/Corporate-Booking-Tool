import { NextRequest, NextResponse } from 'next/server'

// ── GET /auth/callback ────────────────────────────────────────────────────
// Handles TWO different link shapes, because they come from genuinely
// different Supabase flows:
//
// 1. token_hash + type (invite, recovery, email confirmation) — these are
//    admin-issued or server-issued links (inviteUserByEmail,
//    resetPasswordForEmail), verified with verifyOtp().
//
//    THE DEFAULT EMAIL TEMPLATE DOES NOT SEND THIS SHAPE, and an earlier
//    version of this comment claimed it did. `{{ .ConfirmationURL }}` expands
//    to Supabase's OWN endpoint —
//      https://<ref>.supabase.co/auth/v1/verify?token=…&type=invite&redirect_to=…
//    — which consumes the token server-side and then redirects to redirect_to
//    with the session in a URL HASH FRAGMENT (`#access_token=…`). A fragment is
//    never transmitted to a server, so with the default template this route
//    receives no token_hash, no type and no code, falls through to the bottom,
//    and the recipient reads "Link not recognized" on a link that was perfectly
//    valid. It also means a corporate link scanner burns the one-time token at
//    Supabase's verify endpoint before the human ever clicks.
//
//    Both problems have the same fix, and it lives in the Supabase dashboard,
//    not here: Authentication → Email Templates → Invite user must link to this
//    route directly, carrying the hash rather than the ConfirmationURL:
//      <a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=invite">
//    Same change for Reset Password (type=recovery) and Confirm signup
//    (type=signup). Until that is done, invites cannot work.
//
//    Using exchangeCodeForSession()
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

  // No auth params at all. This is almost always a configuration problem
  // rather than a malformed link: if Supabase's Redirect URLs allow-list
  // doesn't contain this exact callback URL, it silently discards `redirectTo`
  // and sends the recipient to the project's Site URL instead, stripping
  // token_hash/type on the way.
  //
  // Previously this redirected to /login, which looks identical to "your
  // session expired" and gave the recipient nothing to report. /auth/confirm
  // already renders a proper "Link not recognized" explanation for exactly
  // this case, so send them there instead.
  return NextResponse.redirect(confirmUrl)
}