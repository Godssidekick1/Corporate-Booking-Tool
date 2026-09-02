import TmcShell from '@/app/components/TmcShell'

// ── /tmc layout ──────────────────────────────────────────────────────────────
// The shell is rendered here, once, rather than opted into by each page.
//
// That is the whole fix for the rail vanishing inside Configurations: pages
// under the old /tmc/settings deliberately skipped TmcShell because that
// section supplied its own sidebar, so navigating there dropped you out of the
// product frame entirely. A layout can't be skipped, and React keeps it mounted
// across navigations within the segment — so the rail no longer re-mounts and
// re-fetches on every page change either.
// ─────────────────────────────────────────────────────────────────────────────

export default function TmcLayout({ children }: { children: React.ReactNode }) {
  return <TmcShell>{children}</TmcShell>
}
