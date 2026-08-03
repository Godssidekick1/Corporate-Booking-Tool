import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Exact-or-child-segment match, e.g. matchesBase('/book/flights', '/book')
// is true but matchesBase('/bookmark', '/book') is false. Plain
// pathname.startsWith(base) would incorrectly treat any future route that
// merely starts with the same characters (e.g. '/bookmark', '/settings-old')
// as falling under this one — this guards every check below against that.
function matchesBase(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(base + '/')
}

function matchesAny(pathname: string, bases: string[]): boolean {
  return bases.some(base => matchesBase(pathname, base))
}

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

  const { data: { user } } = await supabase.auth.getUser()
  const { pathname } = request.nextUrl

  // ── Public — no auth enforcement at all ───────────────────────────────────
  // /auth/* covers the invite/reset hash-token landing (auth/callback) and
  // the set-password page, which must work with only a short-lived recovery
  // session, not a normal signed-in one — enforcing the full protected-route
  // check here would risk bouncing that flow to /login mid-flight.
  // /api/* is intentionally NOT gated here — every /api/book, /api/tmc, etc.
  // route does its own supabase.auth.getUser() check server-side. The proxy
  // is a routing/UX layer, not the security boundary for API calls.
  const isPublic = matchesAny(pathname, ['/auth', '/api'])

  if (isPublic) return supabaseResponse

  // Try metadata first (cheap, no DB call). Fall back to a real DB lookup
  // if metadata is missing role info — this covers accounts created before
  // every creation path consistently set user_metadata.role, and is the
  // authoritative source of truth regardless.
  let resolvedRole = user?.user_metadata?.role as string | undefined

  const isAuthOnly = pathname === '/login'
  const needsRoleCheck = user && (isAuthOnly || matchesBase(pathname, '/tmc'))

  if (needsRoleCheck && !resolvedRole) {
    const { data: employee } = await supabase
      .from('employees')
      .select('role')
      .eq('id', user!.id)
      .single()
    resolvedRole = employee?.role
  }

  const isTmcSideRole = resolvedRole === 'tmc_admin' || resolvedRole === 'tc'

  // ── Auth-only routes — redirect authenticated users to their dashboard ───
  if (user && isAuthOnly) {
    const destination = isTmcSideRole ? '/tmc/dashboard' : '/dashboard'
    return NextResponse.redirect(new URL(destination, request.url))
  }

  // ── Protected routes — redirect unauthenticated users to /login ──────────
  // Every real page in the app other than /login and /auth/* belongs here.
  // Kept as an explicit allow-list (rather than "protect everything except
  // the public list") so a newly added route is protected by default unless
  // someone deliberately adds it above — the safer failure direction.
  const protectedBases = [
    '/dashboard',
    '/settings',
    '/tmc',
    '/book',       // covers /book, /book/flights, /book/hotels, /book/cabs,
                    // /book/price/*, /book/passengers/*,
                    // /book/passengers/edit/*, /book/confirm/*, /book/ticket/*
    '/bookings',
    '/approvals',
    '/reports',
  ]
  const isProtected = matchesAny(pathname, protectedBases)

  if (!user && isProtected) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // ── TMC-only routes — non-TMC users get sent to their own dashboard ──────
  if (user && matchesBase(pathname, '/tmc') && !isTmcSideRole) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}