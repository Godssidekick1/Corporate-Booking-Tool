import { PRIMARY_NAV, CONFIG_GROUPS, isActive, type NavItem } from './tmcNav'
import { canAccess } from '@/app/lib/permissions/canAccess'
import type { PermissionKey } from '@/app/lib/permissions/permissionKeys'

// ── Which TMC pages a person may open at all ────────────────────────────────
// The same entries the rail and the Configurations column show (tmcNav), read
// by proxy.ts before a page is sent: a page whose entry needs a permission the
// counsellor lacks is never rendered for them -- not shown with a "Missing
// permission" banner over an empty editor, and not reachable by typing its
// address. The API routes still refuse on their own; this is entry, they are
// authorization.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIGURATIONS = '/tmc/configurations'

const ENTRIES: NavItem[] = [...PRIMARY_NAV, ...CONFIG_GROUPS.flatMap(g => g.items)]

// The permission a page needs: its most specific entry's. Null = any TMC user.
export function requiredPermission(pathname: string): PermissionKey | null {
  let best: NavItem | null = null
  for (const item of ENTRIES) {
    if (item.permission && isActive(pathname, item.href) && (!best || item.href.length > best.href.length)) best = item
  }
  return best?.permission ?? null
}

// The first Configurations section they may open, in the column's order.
export function firstConfiguration(role: string | undefined, permissions: string[]): string | null {
  for (const group of CONFIG_GROUPS) {
    for (const item of group.items) {
      if (item.soon) continue
      if (!item.permission || canAccess(role, permissions, item.permission)) return item.href
    }
  }
  return null
}

// Where a TMC user asking for this page should be instead, or null to let
// them in. /tmc/configurations itself is a container: it opens on the first
// section they may use, not on Policy for everyone.
export function tmcRedirect(pathname: string, role: string | undefined, permissions: string[]): string | null {
  if (pathname === CONFIGURATIONS || pathname === CONFIGURATIONS + '/') {
    return firstConfiguration(role, permissions) ?? '/tmc/dashboard'
  }
  const needed = requiredPermission(pathname)
  if (!needed || canAccess(role, permissions, needed)) return null
  if (isActive(pathname, CONFIGURATIONS)) {
    const first = firstConfiguration(role, permissions)
    // Never back to a page they cannot open either.
    if (first && first !== pathname && !isActive(pathname, first)) return first
  }
  return '/tmc/dashboard'
}
