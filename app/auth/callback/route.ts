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

  // Use service client for employee lookup — bypasses RLS which
  // may not be set up for a brand new invited user yet.
  const service = createServiceClient()
  const { data: employee } = await service
    .from('employees')
    .select('role, company_id, status')
    .eq('id', user.id)
    .single()

  // First successful login after an email invite — flip invited -> active.
  // Direct-created employees are already 'active' so this is a no-op for them.
  if (employee?.status === 'invited') {
    await service
      .from('employees')
      .update({ status: 'active' })
      .eq('id', user.id)
  }

  if (next !== '/') {
    return NextResponse.redirect(new URL(next, req.url))
  }

  if (employee?.role === 'tmc_admin') {
    return NextResponse.redirect(new URL('/tmc/dashboard', req.url))
  }

  if (employee?.role === 'admin') {
    // Check if this is their first login by looking at setup_completed
 return NextResponse.redirect(new URL('/dashboard', req.url))
}
}