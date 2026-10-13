import type { ShellItem } from '@/app/components/AppShell'

// ── Corporate navigation ─────────────────────────────────────────────────────
// The rail's entries for a client's people, by what they may do. Moved from the
// dashboard page, which was the only page that had a rail at all; now every
// corporate page shares it (CorporateShell). The travel profile is not here:
// it is the person's own entry at the rail's foot.
//
//   everyone            Dashboard, My trips
//   self-booking        Book travel (a CBT-only client's travel desk books)
//   approvers           Approvals: admins, finance, and anyone with reports
//   admin, finance      Reports
//   admin               Settings
// ─────────────────────────────────────────────────────────────────────────────

export function corporateNav(
  role: string,
  { canSelfBook, isApprover, pendingApprovals = 0 }: { canSelfBook: boolean; isApprover: boolean; pendingApprovals?: number }
): ShellItem[] {
  const items: ShellItem[] = [{ label: 'Dashboard', href: '/dashboard', icon: 'dashboard' }]
  if (canSelfBook) items.push({ label: 'Book travel', href: '/book', icon: 'flight' })
  items.push({ label: 'My trips', href: '/bookings', icon: 'trips' })
  if (isApprover) items.push({ label: 'Approvals', href: '/approvals', icon: 'check', badge: pendingApprovals })
  if (role === 'admin' || role === 'finance') items.push({ label: 'Reports', href: '/reports', icon: 'assessment' })
  if (role === 'admin') items.push({ label: 'Settings', href: '/settings', icon: 'settings' })
  return items
}
