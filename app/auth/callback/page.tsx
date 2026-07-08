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

    // Hash fragments (#access_token=...) are browser-only — the server
    // route never sees them. Supabase's client detects them automatically
    // via onAuthStateChange and establishes the session.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          subscription.unsubscribe()

          // Look up role to redirect correctly — same logic as your server route
          const { data: employee } = await supabase
            .from('employees')
            .select('role')
            .eq('id', session.user.id)
            .single()

          if (employee?.role === 'tmc_admin') {
            router.replace('/tmc/dashboard')
          } else {
            router.replace('/dashboard')
          }
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