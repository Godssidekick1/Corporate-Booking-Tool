'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import AppShell from '@/app/components/AppShell'
import { corporateNav } from '@/app/lib/navigation/corporateNav'

// ── CorporateShell ───────────────────────────────────────────────────────────
// The frame for every page a client's people use (app/(corporate)/layout.tsx):
// the same AppShell as the TMC side, with the corporate entries for this
// person's role (corporateNav). What each page shows is still its own; only
// the frame is shared.
//
// Someone still finishing their first-login profile gets no entries: proxy.ts
// sends every other page back to /profile until it is saved, so offering them
// would be links that bounce.
// ─────────────────────────────────────────────────────────────────────────────

interface Me {
  employee: { full_name: string; role: string; band_code: string | null } | null
  client: { name: string } | null
  canSelfBook: boolean
  isApprover: boolean
}

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', finance: 'Finance', employee: 'Employee' }

export default function CorporateShell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [firstLogin, setFirstLogin] = useState(false)
  const [pending, setPending] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/me').then(r => r.json()).then(d => {
      if (cancelled || !d.ok) return
      setMe(d)
      if (d.isApprover) {
        fetch('/api/approvals?summary=1').then(r => r.json())
          .then(s => { if (!cancelled && s.ok) setPending(s.pendingCount ?? 0) })
          .catch(() => {})
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Rechecked on every navigation until the profile is saved: the shell stays
  // mounted when /profile moves on to /dashboard, and would otherwise keep
  // showing no entries until a reload.
  const pathname = usePathname()
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (checked && !firstLogin) return
    let cancelled = false
    fetch('/api/employees/me').then(r => r.json()).then(d => {
      if (cancelled) return
      setFirstLogin(d.firstLoginCompleted === false)
      setChecked(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [pathname, checked, firstLogin])

  const e = me?.employee
  const items = e && !firstLogin
    ? corporateNav(e.role, { canSelfBook: me.canSelfBook !== false, isApprover: me.isApprover === true, pendingApprovals: pending })
    : []

  return (
    <AppShell
      items={items}
      tag={me?.client?.name ?? null}
      profile={{
        href: '/profile',
        name: e?.full_name ?? null,
        sub: e ? [ROLE_LABEL[e.role] ?? e.role, e.band_code].filter(Boolean).join(' · ') : null,
      }}
    >
      {children}
    </AppShell>
  )
}
