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

  const { data: { user } } = await supabase.auth.getUser()
  const { pathname } = request.nextUrl

  const isPublic =
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/verify-email') ||
    pathname.startsWith('/api/')

  if (isPublic) return supabaseResponse

  // Try metadata first (cheap, no DB call). Fall back to a real DB lookup
  // if metadata is missing role info — this covers accounts created before
  // every creation path consistently set user_metadata.role, and is the
  // authoritative source of truth regardless.
  let resolvedRole = user?.user_metadata?.role as string | undefined

  const isAuthOnly = pathname === '/login' || pathname === '/register'
  const needsRoleCheck = user && (isAuthOnly || pathname.startsWith('/tmc'))

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