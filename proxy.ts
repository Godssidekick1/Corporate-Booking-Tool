import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Always use getUser() — never getSession() in middleware.
  // getSession() reads from the cookie without revalidating with Supabase,
  // so a signed-out user with a stale cookie looks authenticated.
  const { data: { user } } = await supabase.auth.getUser()
  const { pathname } = request.nextUrl

  // ── Public routes — always accessible ────────────────────────────────────
  const isPublic =
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/verify-email') ||
    pathname.startsWith('/api/')

  if (isPublic) return supabaseResponse

  // Role as set in user_metadata at invite/create time. Note this can be
  // stale relative to the DB (e.g. right after a role change elsewhere) —
  // it's fine for coarse routing here, but never treat it as an authorization
  // decision. Every route/page still does its own DB-backed role check.
  const metadataRole = user?.user_metadata?.role as string | undefined
  const isTmcSideRole = metadataRole === 'tmc_admin' || metadataRole === 'tc'

  // ── Auth-only routes — redirect authenticated users to their dashboard ───
  const isAuthOnly = pathname === '/login' || pathname === '/register'

  if (user && isAuthOnly) {
    const destination = isTmcSideRole ? '/tmc/dashboard' : '/dashboard'
    return NextResponse.redirect(new URL(destination, request.url))
  }

  // ── Protected routes — redirect unauthenticated users to /login ──────────
  const isProtected =
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/tmc') ||
    pathname.startsWith('/book') ||
    pathname.startsWith('/bookings') ||
    pathname.startsWith('/approvals') ||
    pathname.startsWith('/reports')

  if (!user && isProtected) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // ── TMC-only routes — non-TMC users get sent to their own dashboard ──────
  // Checked by explicit role, not inferred from company_id presence — a
  // corp-side flow that forgets to set company_id in metadata would have
  // silently defeated the old presence-based check.
  if (user && pathname.startsWith('/tmc') && !isTmcSideRole) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}