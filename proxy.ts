import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  // This client's only job here is to read and refresh the session cookie.
  // It uses the anon key — no privileged DB access happens in middleware.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // getUser() validates the session with Supabase on every request.
  // Do not use getSession() here — it reads from the cookie only and
  // can be spoofed. getUser() hits the Supabase Auth server to confirm.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // Unauthenticated user hitting a protected route → send to login
  if (!user && pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Authenticated user hitting login → send to dashboard
  if (user && pathname === '/login') {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  // Always return supabaseResponse, not NextResponse.next() —
  // supabaseResponse carries the refreshed session cookies.
  return supabaseResponse
}

export const config = {
  // Run middleware on dashboard routes and login page only.
  // Exclude the register-company API route — that's a public endpoint.
  matcher: ['/dashboard/:path*', '/login'],
}