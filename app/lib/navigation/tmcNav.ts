import type { PermissionKey } from '@/app/lib/permissions/permissionKeys'

// ── TMC navigation ───────────────────────────────────────────────────────────
// One definition, read by both columns of the shell.
//
// Kept as data rather than JSX so the permission filter, the active-route match
// and the "does this group have any visible children" check are all plain
// functions over the same structure — and so adding a section is one entry here
// rather than an edit in three components.
// ─────────────────────────────────────────────────────────────────────────────

export interface NavItem {
  label: string
  href: string
  // Omitted = visible to any TMC user who can see the section at all.
  permission?: PermissionKey
  // Rendered but not clickable. The section is planned and the entry exists so
  // the shape of the product is legible; hiding it would make the roadmap
  // invisible and the nav feel like it keeps changing shape.
  soon?: boolean
  icon?: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

// Primary rail. Operational surfaces — the things a desk is in all day.
export const PRIMARY_NAV: NavItem[] = [
  { label: 'Dashboard',      href: '/tmc/dashboard',      icon: 'dashboard' },
  { label: 'Clients',        href: '/tmc/clients',      icon: 'groups' },
  { label: 'Reports',        href: '/tmc/reports',        icon: 'assessment', permission: 'view_reports' },
  { label: 'Configurations', href: '/tmc/configurations', icon: 'settings' },
]

// Second column, shown when inside /tmc/configurations.
//
// Grouping rationale: Master is reference data the TMC defines once and reuses
// across clients. Profiles is people and organisations. Commercials is money.
// System is tooling that isn't really configuration but has nowhere better.
export const CONFIG_GROUPS: NavGroup[] = [
  {
    label: 'Master',
    items: [
      { label: 'Policy',           href: '/tmc/configurations/policy',    permission: 'manage_policy' },
      { label: 'Approvals',        href: '/tmc/configurations/approvals', permission: 'manage_approvals' },
      { label: 'Deal codes',       href: '#', soon: true },
      { label: 'Forms of payment', href: '#', soon: true },
      { label: 'Branches',         href: '#', soon: true },
    ],
  },
  {
    label: 'Profiles',
    items: [
      { label: 'Traveller profiles', href: '/tmc/configurations/traveller-profiles', permission: 'manage_users' },
      { label: 'Users (TCs)',        href: '/tmc/configurations/users',              permission: 'manage_users' },
      { label: 'Client groups',      href: '/tmc/configurations/client-groups',      permission: 'manage_client_groups' },
      { label: 'Cost centres',       href: '/tmc/configurations/cost-centres',       permission: 'manage_users' },
    ],
  },
  {
    label: 'Commercials',
    items: [
      { label: 'Markup',          href: '#', soon: true },
      { label: 'Discounts',       href: '#', soon: true },
      { label: 'Processing fees', href: '#', soon: true },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Integrations',     href: '/tmc/configurations/integrations',     },
      { label: 'Rule engine test', href: '/tmc/configurations/rule-engine-test', permission: 'manage_policy' },
    ],
  },
]

// ── isActive ─────────────────────────────────────────────────────────────────
// Exact match, or a child segment. `startsWith` alone would light up
// /tmc/clients for /tmc/clients-archive, so the boundary is explicit.
//
// This replaces the old `activeLabel` prop — a typed union that had to be
// widened by hand every time a section was added, and passed correctly by every
// page that rendered the shell.
// ─────────────────────────────────────────────────────────────────────────────
export function isActive(pathname: string, href: string): boolean {
  if (href === '#') return false
  return pathname === href || pathname.startsWith(href + '/')
}

// Which group contains the current route — used to auto-open the right group on
// first paint, so landing deep in Configurations doesn't show everything closed.
export function groupContaining(pathname: string): string | null {
  for (const group of CONFIG_GROUPS) {
    if (group.items.some(item => isActive(pathname, item.href))) return group.label
  }
  return null
}
