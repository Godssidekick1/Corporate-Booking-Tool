import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'
  const type = searchParams.get('type')  // 'invite' | 'recovery' | null

  if (!code) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    console.error('Auth callback error:', error.message)
    return NextResponse.redirect(new URL('/login', req.url))
  }

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // Invited users must set a password before accessing the app
  if (type === 'invite') {
    return NextResponse.redirect(new URL('/auth/set-password', req.url))
  }

  // Explicit next param
  if (next !== '/') {
    return NextResponse.redirect(new URL(next, req.url))
  }

  // Look up role and send to the right dashboard
  const { data: employee } = await supabase
    .from('employees')
    .select('role')
    .eq('id', user.id)
    .single()

  if (employee?.role === 'tmc_admin') {
    return NextResponse.redirect(new URL('/tmc/dashboard', req.url))
  }

  return NextResponse.redirect(new URL('/dashboard', req.url))
}