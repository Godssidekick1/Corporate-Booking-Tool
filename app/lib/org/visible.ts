import type { OrgPerson } from '@/app/lib/repositories/org'

// ── What the org chart shows of a colleague ──────────────────────────────────
// Name, title, department and email for everyone (as Teams shows). A band is
// seniority, often treated as confidential: it is shown on the viewer's own
// card, or to a corporate admin, and to nobody else.
// ─────────────────────────────────────────────────────────────────────────────

export function visible(p: OrgPerson, viewer: { id: string; role: string | null }) {
  const seesBand = viewer.role === 'admin' || p.id === viewer.id
  return {
    id: p.id,
    name: p.full_name,
    title: p.designation,
    department: p.department,
    email: p.email,
    isAdmin: p.role === 'admin',
    topOfHierarchy: p.top_of_hierarchy,
    directReports: p.direct_reports,
    ...(seesBand ? { band: p.band_code } : {}),
  }
}
