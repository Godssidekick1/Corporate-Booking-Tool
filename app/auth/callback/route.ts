import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/utils/supabase/service'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

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

  if (next !== '/') {
    return NextResponse.redirect(new URL(next, req.url))
  }

  // Use service client for employee lookup — bypasses RLS which
  // may not be set up for a brand new invited user yet.
  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('role, company_id')
    .eq('id', user.id)
    .single()

  if (employee?.role === 'tmc_admin') {
    return NextResponse.redirect(new URL('/tmc/dashboard', req.url))
  }

  if (employee?.role === 'admin') {
    // Check if this is their first login by looking at setup_confirmed
    const { data: company } = await service
      .from('companies')
      .select('settings')
      .eq('id', employee.company_id)
      .single()

    const setupConfirmed = company?.settings?.setup_confirmed ?? false
    if (!setupConfirmed) {
      return NextResponse.redirect(new URL('/setup', req.url))
    }
  }

  return NextResponse.redirect(new URL('/dashboard', req.url))
}