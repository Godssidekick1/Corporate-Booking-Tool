import CorporateShell from '@/app/components/CorporateShell'

// ── (corporate) layout ───────────────────────────────────────────────────────
// Every page a client's people use -- dashboard, trips, approvals, travel
// profile, reports, settings -- inside one frame, the same rail as the TMC
// side (AppShell). A route group: the folder name is not part of any URL.
// The booking flow (/book) keeps its own step bar and is not in here.
// ─────────────────────────────────────────────────────────────────────────────

export default function CorporateLayout({ children }: { children: React.ReactNode }) {
  return <CorporateShell>{children}</CorporateShell>
}
