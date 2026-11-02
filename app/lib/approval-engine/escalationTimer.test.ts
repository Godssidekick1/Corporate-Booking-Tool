import { describe, it, expect, vi, afterEach } from 'vitest'
import { startEscalationTimer, shouldRunHere } from './escalationTimer'

// ── The escalation timer, on its own ─────────────────────────────────────────
// Fake timers and a fake sweep: when it runs, that it never overlaps itself,
// that a failure does not stop it, and where it is switched off. The real
// sweep against the database is tested in tests/routes/escalation.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const MIN = 60_000
const quiet = { escalated: 0, kept: 0 }

describe('escalation timer', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('runs 30 s after start, then every N minutes', async () => {
    vi.useFakeTimers()
    const sweep = vi.fn().mockResolvedValue(quiet)
    const t = startEscalationTimer({ everyMinutes: 5, sweep })
    await vi.advanceTimersByTimeAsync(29_000)
    expect(sweep).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(sweep).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(sweep).toHaveBeenCalledTimes(4)
    t.stop()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(sweep).toHaveBeenCalledTimes(4)
  })

  it('a slow run is never overlapped: the next waits for it to finish', async () => {
    vi.useFakeTimers()
    let finish: (v: typeof quiet) => void = () => {}
    const sweep = vi.fn(() => new Promise<typeof quiet>(r => { finish = r }))
    const t = startEscalationTimer({ everyMinutes: 1, firstAfterMs: 0, sweep })
    await vi.advanceTimersByTimeAsync(0)
    expect(sweep).toHaveBeenCalledTimes(1)
    // Still running ten minutes later: nothing new started.
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(sweep).toHaveBeenCalledTimes(1)
    finish(quiet)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(sweep).toHaveBeenCalledTimes(2)
    t.stop()
  })

  it('a failed run is logged and the next one still comes', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sweep = vi.fn().mockRejectedValueOnce(new Error('database away')).mockResolvedValue(quiet)
    const t = startEscalationTimer({ everyMinutes: 1, firstAfterMs: 0, sweep })
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(sweep).toHaveBeenCalledTimes(2)
    t.stop()
  })

  it('is off on Vercel, during a build, and when switched off', () => {
    expect(shouldRunHere({})).toBe(true)
    expect(shouldRunHere({ VERCEL: '1' })).toBe(false)
    expect(shouldRunHere({ NEXT_PHASE: 'phase-production-build' })).toBe(false)
    expect(shouldRunHere({ ESCALATION_SWEEP: 'off' })).toBe(false)
    expect(shouldRunHere({ ESCALATION_SWEEP: 'OFF' })).toBe(false)
  })
})
