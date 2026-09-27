import { NextResponse, type NextRequest } from 'next/server'
import { principalForToken, SESSION_COOKIE, TMC_ROLES } from '@/app/lib/auth/session'

// ── proxy.ts: the page gate ──────────────────────────────────────────────────
// Runs before every PAGE request (API routes authenticate themselves; see the
// matcher). Decides only where a browser should be: signed out -> /login,
// admin-set password not yet replaced -> /auth/set-password, first-login
// profile not done -> /profile, corporate user on /tmc -> /dashboard.
//
// ONE LOOKUP, FROM THE DATABASE. principalForToken is the same session lookup
// every API route uses: session -> account -> employee -> client/TMC standing.
// The role and the must-change-password flag come from there. Under GoTrue
// they came from user_metadata, which the user could rewrite on themselves (a
// self-granted tmc_admin opened the /tmc pages; a cleared must_set_password
// skipped the forced change). A deactivated person has no session at all
// here: the lookup refuses them.
//
// Next 16 runs proxy on the Node.js runtime, so this is node-postgres like
// everywhere else.
//
// This is navigation, not authorization. Every page's data comes from API
// routes that check for themselves, and /platform's layout checks platform
// membership itself.
// ─────────────────────────────────────────────────────────────────────────────

// Exact-or-child-segment match: /book/flights matches /book, /bookmark does not.
function matchesBase(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(base + '/')
}

// Keep this an explicit allow-list. A new page is NOT protected until it is
// added here (its data still is, by its API routes).
const PROTECTED = ['/dashboard', '/settings', '/tmc', '/book', '/bookings', '/approvals', '/reports', '/profile', '/platform']

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url))

  // /auth/* completes authentication (invite and reset links, the forced
  // password change), so it must be reachable without a normal session.
  if (matchesBase(pathname, '/auth')) return NextResponse.next()

  const isProtected = PROTECTED.some(base => matchesBase(pathname, base))
  const isLogin = pathname === '/login'
  if (!isProtected && !isLogin) return NextResponse.next()

  // Failing open on a database error is the right call for navigation (a blip
  // must not lock everyone out, and the API routes still refuse), but it must
  // be loud when it happens.
  let me = null
  try {
    me = await principalForToken(request.cookies.get(SESSION_COOKIE)?.value)
  } catch (err) {
    console.error('[proxy] session lookup failed:', err)
  }

  if (!me) {
    if (!isProtected) return NextResponse.next()
    const login = new URL('/login', request.url)
    login.searchParams.set('next', pathname)
    return NextResponse.redirect(login)
  }

  const role = me.employee?.role ?? null
  const tmcSide = role !== null && TMC_ROLES.includes(role)

  // An admin chose this person's password, so the admin knows it. Nothing else
  // until they replace it, including the profile step.
  if (me.mustChangePassword && (isProtected || isLogin)) return to('/auth/set-password')

  // Already signed in: /login goes to where they belong. A platform admin has
  // no employees row, by design. An account with neither has nowhere to go and
  // sees the sign-in page (redirecting it to /login would loop).
  if (isLogin) {
    const home = tmcSide ? '/tmc/dashboard' : role ? '/dashboard' : me.isPlatformAdmin ? '/platform' : null
    return home ? to(home) : NextResponse.next()
  }

  // Corporate employees finish their first-login profile before anything else.
  // /profile is where they do it (no loop), TMC staff have no such step, and
  // /platform is for platform admins, who have no employee record.
  if (
    me.employee && !tmcSide && me.employee.firstLoginCompleted === false &&
    !matchesBase(pathname, '/profile') && !matchesBase(pathname, '/platform')
  ) {
    return to('/profile?first=1')
  }

  if (matchesBase(pathname, '/tmc') && !tmcSide) return to('/dashboard')

  return NextResponse.next()
}

// /api is excluded: API routes authenticate themselves. So are static assets.
export const config = {
  matcher: [
    '/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
