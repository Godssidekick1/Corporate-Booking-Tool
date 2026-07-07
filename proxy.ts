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

  // ── Protected routes: unauthenticated → /login ────────────────────
  const isProtected =
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/setup') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/tmc')

  if (!user && isProtected) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // ── Auth-only routes: authenticated → appropriate dashboard ───────
  const isAuthOnly = pathname === '/login' || pathname === '/register'

  if (user && isAuthOnly) {
    // We can't check role here without a DB call — redirect to dashboard
    // and let the dashboard handle role-based routing if needed.
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/setup/:path*',
    '/settings/:path*',
    '/tmc/:path*',
    '/login',
    '/register',
  ],
}