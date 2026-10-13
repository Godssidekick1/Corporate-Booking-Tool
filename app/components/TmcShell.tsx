'use client'

import { useEffect, useState } from 'react'
import AppShell from '@/app/components/AppShell'
import { canAccess } from '@/app/lib/permissions/canAccess'
import { PRIMARY_NAV } from '@/app/lib/navigation/tmcNav'

// ── TmcShell ─────────────────────────────────────────────────────────────────
// The frame for every /tmc route (app/tmc/layout.tsx): the shared AppShell,
// holding the TMC's entries, filtered by the counsellor's permissions.
// Rendered once from the layout rather than opted into per page, which is what
// stops the rail disappearing when you navigate into Configurations.
// ─────────────────────────────────────────────────────────────────────────────

interface Employee {
  full_name: string
  email: string
  role: string
  tmc_id: string
}

export default function TmcShell({ children }: { children: React.ReactNode }) {
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [permissions, setPermissions] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/me')
      .then(r => r.json())
      .then(d => {
        if (cancelled || !d.ok) return
        setEmployee(d.employee)
        setPermissions(d.permissions ?? [])
      })
    return () => { cancelled = true }
  }, [])

  const items = PRIMARY_NAV.filter(
    item => !item.permission || canAccess(employee?.role, permissions, item.permission)
  )

  return (
    <AppShell
      items={items}
      tag={employee ? (employee.role === 'tmc_admin' ? 'TMC Admin' : 'Travel Counsellor') : null}
      // /tmc/profile, not /profile. The latter is the traveller profile --
      // passport, meal preference -- which no TMC or TC user should ever be
      // asked for.
      profile={{ href: '/tmc/profile', name: employee?.full_name ?? null }}
    >
      {children}
    </AppShell>
  )
}
