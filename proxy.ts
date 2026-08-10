import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Exact-or-child-segment match.
// /book/flights → matches /book
// /bookmark     → does NOT match /book
function matchesBase(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(base + '/')
}

function matchesAny(pathname: string, bases: string[]): boolean {
  return bases.some((base) => matchesBase(pathname, base))
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC AUTH ROUTES
  // ─────────────────────────────────────────────────────────────────────────
  //
  // /auth/* handles things like:
  // - auth/callback
  // - password recovery
  // - set-password
  //
  // These routes should not call supabase.auth.getUser().
  // They need to be able to complete the authentication flow without being
  // treated as normally authenticated protected pages.
  //
  // This check happens BEFORE creating the Supabase client and BEFORE
  // getUser(), avoiding an unnecessary network round trip to Supabase.
  //
  // /api/* is NOT handled here because it is excluded from the matcher below.
  // API routes perform their own authentication server-side.
  // ─────────────────────────────────────────────────────────────────────────

  if (matchesAny(pathname, ['/auth'])) {
    return NextResponse.next({ request })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SUPABASE SERVER CLIENT
  // ─────────────────────────────────────────────────────────────────────────

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },

        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value)
          })

          supabaseResponse = NextResponse.next({ request })

          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  // ─────────────────────────────────────────────────────────────────────────
  // AUTHENTICATION
  // ─────────────────────────────────────────────────────────────────────────
  //
  // At this point we know the request is not /auth/* and not /api/*.
  // Therefore getUser() is only performed for pages where the proxy actually
  // needs authentication information.
  // ─────────────────────────────────────────────────────────────────────────

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // ─────────────────────────────────────────────────────────────────────────
  // PROTECTED ROUTES
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Keep this as an explicit allow-list.
  //
  // IMPORTANT:
  // A newly created page is NOT automatically protected by this list.
  // It must be added here if it requires authentication.
  // ─────────────────────────────────────────────────────────────────────────

  const protectedBases = [
    '/dashboard',
    '/settings',
    '/tmc',
    '/book',
    '/bookings',
    '/approvals',
    '/reports',
    '/profile',
  ]

  const isProtected = matchesAny(pathname, protectedBases)

  // ─────────────────────────────────────────────────────────────────────────
  // ROUTE TYPES
  // ─────────────────────────────────────────────────────────────────────────

  const isAuthOnly = pathname === '/login'

  const isProfilePage = matchesBase(pathname, '/profile')

  const needsRoleCheck =
    !!user &&
    (isAuthOnly || matchesBase(pathname, '/tmc'))

  // Profile itself is where the user completes onboarding, so don't redirect
  // /profile → /profile when first_login_completed is false.
  const needsOnboardingCheck =
    !!user &&
    isProtected &&
    !isProfilePage

  // ─────────────────────────────────────────────────────────────────────────
  // USER ROLE / ONBOARDING DATA
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Try user_metadata first for role because it avoids a database query when
  // the metadata is present.
  //
  // first_login_completed is stored in employees, so when onboarding needs to
  // be checked we fetch it from the database.
  // ─────────────────────────────────────────────────────────────────────────

  let resolvedRole =
    user?.user_metadata?.role as string | undefined

  let firstLoginCompleted: boolean | undefined

  if (
    (needsRoleCheck || needsOnboardingCheck) &&
    (!resolvedRole || firstLoginCompleted === undefined)
  ) {
    const { data: employee } = await supabase
      .from('employees')
      .select('role, first_login_completed')
      .eq('id', user!.id)
      .single()

    resolvedRole = resolvedRole ?? employee?.role
    firstLoginCompleted = employee?.first_login_completed
  }

  const isTmcSideRole =
    resolvedRole === 'tmc_admin' ||
    resolvedRole === 'tc'

  // ─────────────────────────────────────────────────────────────────────────
  // FIRST-LOGIN ONBOARDING
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Corporate-side employees who haven't completed their first-login profile
  // are forced to /profile?first=1.
  //
  // TMC admins / TCs are excluded because they are TMC-side users and don't
  // personally go through the corporate employee booking profile flow.
  //
  // /profile itself is excluded above to prevent a redirect loop.
  // ─────────────────────────────────────────────────────────────────────────

  if (
    needsOnboardingCheck &&
    !isTmcSideRole &&
    firstLoginCompleted === false
  ) {
    const profileUrl = new URL('/profile', request.url)

    profileUrl.searchParams.set('first', '1')

    return NextResponse.redirect(profileUrl)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOGIN PAGE
  // ─────────────────────────────────────────────────────────────────────────
  //
  // If an already-authenticated user visits /login, send them to the correct
  // dashboard instead.
  // ─────────────────────────────────────────────────────────────────────────

  if (user && isAuthOnly) {
    const destination = isTmcSideRole
      ? '/tmc/dashboard'
      : '/dashboard'

    return NextResponse.redirect(
      new URL(destination, request.url)
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROTECTED ROUTES
  // ─────────────────────────────────────────────────────────────────────────
  //
  // An unauthenticated user trying to access a protected page gets sent to
  // /login.
  //
  // The original destination is preserved in ?next= so the application can
  // optionally return the user there after login.
  // ─────────────────────────────────────────────────────────────────────────

  if (!user && isProtected) {
    const loginUrl = new URL('/login', request.url)

    loginUrl.searchParams.set('next', pathname)

    return NextResponse.redirect(loginUrl)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TMC-ONLY ROUTES
  // ─────────────────────────────────────────────────────────────────────────
  //
  // A logged-in corporate employee cannot access /tmc/*.
  // Only tmc_admin and tc users are allowed there.
  // ─────────────────────────────────────────────────────────────────────────

  if (
    user &&
    matchesBase(pathname, '/tmc') &&
    !isTmcSideRole
  ) {
    return NextResponse.redirect(
      new URL('/dashboard', request.url)
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ALLOW REQUEST
  // ─────────────────────────────────────────────────────────────────────────

  return supabaseResponse
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCHER
// ─────────────────────────────────────────────────────────────────────────────
//
// /api and /api/* are excluded because API routes perform their own
// authentication server-side.
//
// Static assets are also excluded.
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  matcher: [
    '/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}