import { notFound } from 'next/navigation'
import { requirePlatformAdmin } from '@/app/lib/permissions/requirePlatformAdmin'
import SignOutButton from './SignOutButton'

// ── /platform layout ─────────────────────────────────────────────────────────
// The gate. A server component, so the check runs before any of this reaches a
// browser — and it uses the service client, which is the only thing that can
// read platform_admins at all (RLS is on with no policies).
//
// notFound(), not a redirect and not a 403. A 403 confirms the surface exists
// and that this account simply lacks it, which tells anyone probing exactly
// where to aim. 404 says nothing. It costs a legitimate platform admin nothing,
// because they never see either.
//
// This is layer two. proxy.ts sends an unauthenticated visitor to /login, and
// every /api/platform route repeats the check itself — the page gate protects
// what is rendered, not what is reachable, and an API route must never trust a
// caller because a page above it was allowed to render.
// ─────────────────────────────────────────────────────────────────────────────

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const check = await requirePlatformAdmin()
  if (!check.ok) notFound()

  return (
    <div style={{ minHeight: '100vh', background: '#F7F8FC' }}>
      <header style={header}>
        <div style={wordmark}>
          <span style={wmMain}>TravelDesk</span>
          <span style={wmBy}>Platform</span>
        </div>
        {/* A platform admin has no employees row, so neither the corporate
            sidebar nor the TMC rail is reachable — and those hold every other
            sign-out button in the app. Without this one there is no way out of
            this surface at all. */}
        <div style={headerRight}>
          <span style={who}>{check.admin.email}</span>
          <SignOutButton />
        </div>
      </header>
      <main style={{ padding: '28px 32px', maxWidth: 1180, margin: '0 auto' }}>
        {children}
      </main>
    </div>
  )
}

const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '14px 32px', background: '#000835', color: '#fff',
}
const wordmark: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 10 }
const wmMain: React.CSSProperties = { fontSize: 17, fontWeight: 600, letterSpacing: '-0.3px' }
const wmBy: React.CSSProperties = {
  fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: 4, padding: '2px 6px',
}
const headerRight: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 14 }
const who: React.CSSProperties = { fontSize: 12, color: 'rgba(255,255,255,0.55)' }
