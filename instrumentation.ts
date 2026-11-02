// ── Server start ─────────────────────────────────────────────────────────────
// Next.js calls register() once when a server starts (instrumentation.md).
// The one thing started here is the approval-escalation sweep
// (app/lib/approval-engine/escalationTimer.ts). The runtime is checked before
// the import: Next.js inlines NEXT_RUNTIME per build, so the edge build drops
// the database code entirely.
// ─────────────────────────────────────────────────────────────────────────────

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { shouldRunHere, startEscalationTimer } = await import('./app/lib/approval-engine/escalationTimer')
  if (!shouldRunHere()) return
  const minutes = Number(process.env.ESCALATION_SWEEP_MINUTES)
  startEscalationTimer({ everyMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : undefined })
}
