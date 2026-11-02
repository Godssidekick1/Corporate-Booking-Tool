import { db, asSystem } from '@/app/lib/db'
import { escalateDueApprovals, type EscalationRun } from './escalate'

// ── Escalation that runs itself ──────────────────────────────────────────────
// An approval escalates when it has waited too long, which is a matter of
// time passing: nothing in a request notices it. So the server sweeps on a
// timer of its own, started once at boot (instrumentation.ts), for as long as
// it runs. Nothing for a host to schedule.
//
//   first run      30 s after start, which also catches up on whatever fell
//                  due while the server was down: the sweep looks for
//                  anything overdue, not "due since the last run"
//   then           every ESCALATION_SWEEP_MINUTES (default 5)
//   several        servers side by side are safe: each approval is claimed
//                  by one conditional update (approvals.claimForEscalation)
//
// A run never overlaps the one before, an error is logged and the next tick
// still comes, and the timer does not keep the process alive on shutdown.
// POST /api/internal/escalate and `npm run escalate` remain for a manual run.
// ─────────────────────────────────────────────────────────────────────────────

export interface EscalationTimer { stop: () => void }

type Sweep = () => Promise<EscalationRun>

const defaultSweep: Sweep = () => asSystem(() => escalateDueApprovals(db))

export function startEscalationTimer(options: {
  everyMinutes?: number
  firstAfterMs?: number
  sweep?: Sweep
} = {}): EscalationTimer {
  const every = Math.max(1, options.everyMinutes ?? 5) * 60_000
  const sweep = options.sweep ?? defaultSweep
  let running = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (ms: number) => {
    if (stopped) return
    timer = setTimeout(tick, ms)
    timer.unref?.()
  }

  async function tick() {
    if (running) return schedule(every)
    running = true
    try {
      const run = await sweep()
      if (run.escalated || run.kept) {
        console.info('[escalation] sweep', { escalated: run.escalated, kept: run.kept })
      }
    } catch (err) {
      console.error('[escalation] sweep failed; trying again at the next tick', err)
    } finally {
      running = false
      schedule(every)
    }
  }

  schedule(options.firstAfterMs ?? 30_000)
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

// Whether instrumentation.ts starts it (on the Node.js runtime, which it
// checks itself): not on Vercel (no long-lived process; its free cron runs
// once a day), not during a build, and not when ESCALATION_SWEEP=off.
export function shouldRunHere(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL) return false
  if (env.NEXT_PHASE === 'phase-production-build') return false
  return (env.ESCALATION_SWEEP ?? 'on').toLowerCase() !== 'off'
}
