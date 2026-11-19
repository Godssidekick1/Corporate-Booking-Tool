import { describe, it, expect } from 'vitest'
import { idlePhase, keepAliveDue, IDLE_MS, WARN_MS, KEEPALIVE_EVERY_MS } from './idle'

// ── Idle sign-out timing: 10 minutes, a minute's warning ─────────────────────

const T = 1_800_000_000_000

describe('idlePhase', () => {
  it('active for the first nine minutes', () => {
    expect(idlePhase(T, T)).toEqual({ phase: 'active' })
    expect(idlePhase(T, T + IDLE_MS - WARN_MS - 1)).toEqual({ phase: 'active' })
  })

  it('the last minute warns, counting the seconds down', () => {
    expect(idlePhase(T, T + IDLE_MS - WARN_MS)).toEqual({ phase: 'warning', secondsLeft: 60 })
    expect(idlePhase(T, T + IDLE_MS - 30_500)).toEqual({ phase: 'warning', secondsLeft: 31 })
    expect(idlePhase(T, T + IDLE_MS - 1)).toEqual({ phase: 'warning', secondsLeft: 1 })
  })

  it('expired at ten minutes, and at once for a machine that slept far past them', () => {
    expect(idlePhase(T, T + IDLE_MS)).toEqual({ phase: 'expired' })
    expect(idlePhase(T, T + 60 * 60_000)).toEqual({ phase: 'expired' })
  })

  it('the limits are the agreed ones', () => {
    expect(IDLE_MS).toBe(10 * 60_000)
    expect(WARN_MS).toBe(60_000)
  })
})

describe('keepAliveDue', () => {
  it('at most once a minute', () => {
    expect(keepAliveDue(T, T + KEEPALIVE_EVERY_MS - 1)).toBe(false)
    expect(keepAliveDue(T, T + KEEPALIVE_EVERY_MS)).toBe(true)
  })
})
