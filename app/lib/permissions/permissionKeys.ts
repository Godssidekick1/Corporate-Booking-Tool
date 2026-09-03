// ── Permission keys ──────────────────────────────────────────────────────────
// The canonical list. Previously duplicated verbatim in three files
// (api/tmc/tcs/route.ts, api/tmc/tcs/[id]/route.ts, and the users screen), which
// meant adding a key required remembering all three — and the UI list had
// already drifted to a different label style from the server lists.
//
// There is no DB-level enum on employee_permissions.permission_key, so this
// array is the only thing preventing an arbitrary string being granted.
// ─────────────────────────────────────────────────────────────────────────────

export const PERMISSION_KEYS = [
  'manage_policy',
  'manage_users',
  'manage_approvals',
  'manage_client_groups',
  'manage_deal_codes',
  'view_reports',
  'book_on_behalf',
] as const

export type PermissionKey = typeof PERMISSION_KEYS[number]

export interface PermissionDef {
  key: PermissionKey
  label: string
  desc: string
  // Grantable but not yet enforced anywhere. Surfaced so the UI can say so
  // rather than implying it does something.
  reserved?: boolean
}

export const PERMISSIONS: PermissionDef[] = [
  {
    key: 'manage_policy',
    label: 'Manage policy',
    desc: 'Create and edit policy groups, band ranks and travel rules',
  },
  {
    key: 'manage_users',
    label: 'Manage people',
    desc: 'Traveller profiles, bands, reporting lines, cost centres',
  },
  {
    key: 'manage_approvals',
    label: 'Manage approvals',
    desc: 'Build approval chains and decide who approves for whom',
  },
  {
    key: 'manage_client_groups',
    label: 'Manage client groups',
    desc: 'Create and edit the groups clients are organised into',
  },
  {
    key: 'manage_deal_codes',
    label: 'Manage deal codes',
    desc: 'Negotiated airline codes, buckets, and which clients they reach',
  },
  {
    key: 'view_reports',
    label: 'View reports',
    desc: 'Cross-client spend, booking activity and compliance',
  },
  {
    key: 'book_on_behalf',
    label: 'Book on behalf',
    desc: 'Act as a counsellor and make bookings for travellers',
    // No route or nav gate references this yet — granting it currently changes
    // nothing. Kept because the CBT flow will need it.
    reserved: true,
  },
]

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value)
}
