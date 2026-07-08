'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

export default function AuthCallbackPage() {
  const router = useRouter()

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )

    async function redirectByRole(userId: string) {
      const { data: employee } = await supabase
        .from('employees')
        .select('role, status')
        .eq('id', userId)
        .single()

      if (employee?.role === 'tmc_admin') {
        router.replace('/tmc/dashboard')
      } else {
        router.replace('/dashboard')
      }
    }

    // ── Handle ?code= param (magic link / OAuth) ──────────────────────
    // This was previously done server-side in route.ts. Doing it
    // client-side here so both flows live in one file.
    const code = new URLSearchParams(window.location.search).get('code')
    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ data, error }) => {
        if (error || !data.session) {
          router.replace('/login')
          return
        }
        redirectByRole(data.session.user.id)
      })
      return
    }

    // ── Handle #access_token= hash (invite emails) ────────────────────
    // Hash fragments never reach the server — Supabase client detects
    // them automatically via onAuthStateChange.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          subscription.unsubscribe()
          redirectByRole(session.user.id)
        }
        if (event === 'TOKEN_REFRESHED') {
          subscription.unsubscribe()
          router.replace('/dashboard')
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [router])

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'Inter', -apple-system, sans-serif",
      background: '#F7F8FC',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: '32px',
          height: '32px',
          border: '2px solid #E5E7EB',
          borderTop: '2px solid #000835',
          borderRadius: '50%',
          margin: '0 auto 16px',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ fontSize: '13px', color: '#6B7280', margin: 0 }}>
          Signing you in…
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  )
}