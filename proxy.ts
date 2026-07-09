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
  // These never redirect regardless of auth state.
  const isPublic =
    pathname.startsWith('/auth/') ||       // /auth/callback, /auth/set-password
    pathname.startsWith('/verify-email') ||
    pathname.startsWith('/api/')            // all API routes handle their own auth

  if (isPublic) return supabaseResponse

  // ── Auth-only routes — redirect authenticated users away ─────────────────
  // Signed-in users hitting /login or /register get sent to their dashboard.
  const isAuthOnly = pathname === '/login' || pathname === '/register'

  if (user && isAuthOnly) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  // ── Protected routes — redirect unauthenticated users to /login ──────────
  const isProtected =
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/setup') ||
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

  // ── TMC-only routes — non-TMC users get sent to their dashboard ──────────
  // We avoid a DB call here — TMC admins have no company_id in their JWT.
  // The tmc/dashboard page itself handles the role check via /api/me.
  // This is just a coarse guard to prevent obvious wrong-door access.
  if (user && pathname.startsWith('/tmc')) {
    const companyId = user.user_metadata?.company_id
    // If they have a company_id they're a corporate user, not a TMC admin
    if (companyId) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static  (Next.js static files)
     * - _next/image   (Next.js image optimisation)
     * - favicon.ico
     * - public folder files (png, jpg, svg, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}