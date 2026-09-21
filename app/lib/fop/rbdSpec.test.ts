import { describe, it, expect } from 'vitest'
import {
  parseRbdSpec,
  validateRbdSpec,
  matchesAllLegs,
  rbdSpecBreadth,
  formatRbdSpec,
} from './rbdSpec'

// ── rbdSpec ──────────────────────────────────────────────────────────────────
// Booking-class matching decides whether a commercial rule or a form of payment
// applies to an itinerary. Two behaviours here are load-bearing and neither is
// obvious from a call site:
//
//   1. matchesAllLegs fails CLOSED. A leg with no booking code cannot be shown
//      to be in the set, so a restricted rule does not apply. Charging a
//      class-restricted markup on a class it was never filed for is the worse
//      error.
//
//   2. rbdSpecBreadth returns Infinity for an unrestricted spec, NOT 0. The
//      resolver sorts ascending and treats smaller as more specific; 0 would
//      make "any class" the most specific rule in the system and invert every
//      precedence decision.
//
// Both are the kind of thing a refactor silently reverses, which is exactly
// what these tests exist to catch.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRbdSpec', () => {
  it('accepts the three separators airlines actually use', () => {
    expect(parseRbdSpec('Y,B,M')).toEqual(['B', 'M', 'Y'])
    expect(parseRbdSpec('Y B M')).toEqual(['B', 'M', 'Y'])
    expect(parseRbdSpec('Y/B/M')).toEqual(['B', 'M', 'Y'])
  })

  it('uppercases, de-duplicates and sorts', () => {
    expect(parseRbdSpec('y, b , y')).toEqual(['B', 'Y'])
  })

  it('returns empty for blank input, which means "any class"', () => {
    expect(parseRbdSpec(null)).toEqual([])
    expect(parseRbdSpec(undefined)).toEqual([])
    expect(parseRbdSpec('   ')).toEqual([])
  })

  it('drops unparseable fragments rather than throwing', () => {
    // Parsed live as an admin types, so a trailing comma must not blow up.
    expect(parseRbdSpec('Y,')).toEqual(['Y'])
    expect(parseRbdSpec('Y, YB, 7, M')).toEqual(['M', 'Y'])
  })
})

describe('validateRbdSpec', () => {
  it('passes a well-formed spec and a blank one', () => {
    expect(validateRbdSpec('Y, B, M')).toBeNull()
    expect(validateRbdSpec('')).toBeNull()
    expect(validateRbdSpec(null)).toBeNull()
  })

  it('rejects anything that is not a single letter', () => {
    expect(validateRbdSpec('Y, YB')).toContain('YB')
    expect(validateRbdSpec('7')).toContain('7')
  })

  it('rejects a spec that parses to nothing but was not blank', () => {
    expect(validateRbdSpec(',,,')).toContain('at least one booking class')
  })
})

describe('matchesAllLegs', () => {
  it('an unrestricted spec matches everything', () => {
    expect(matchesAllLegs(null, ['Y'])).toBe(true)
    expect(matchesAllLegs('', ['S', 'T'])).toBe(true)
    // Including an itinerary with no legs at all.
    expect(matchesAllLegs(null, [])).toBe(true)
  })

  it('requires EVERY leg to be in the set, not just the first', () => {
    expect(matchesAllLegs('Y,B', ['Y', 'B'])).toBe(true)
    // The case the per-leg capture exists for: first hop Y, second hop L.
    expect(matchesAllLegs('Y,B', ['Y', 'L'])).toBe(false)
  })

  it('fails closed when a leg has no booking code', () => {
    expect(matchesAllLegs('Y', [null])).toBe(false)
    expect(matchesAllLegs('Y', ['Y', undefined])).toBe(false)
    expect(matchesAllLegs('Y', ['Y', '  '])).toBe(false)
  })

  it('fails closed when a restricted spec meets an itinerary with no legs', () => {
    expect(matchesAllLegs('Y', [])).toBe(false)
  })

  it('normalises case and whitespace on the leg side', () => {
    expect(matchesAllLegs('Y,B', [' y ', 'b'])).toBe(true)
  })

  it('does not match the real-world Y/B/M against S/T discounted fares', () => {
    // The single most common reason a correct-looking rule never fires: Y is
    // the full-fare economy bucket, and discounted fares sell in S, T, U, Q.
    expect(matchesAllLegs('Y,B,M', ['S', 'T'])).toBe(false)
  })
})

describe('rbdSpecBreadth', () => {
  it('counts the classes a spec covers', () => {
    expect(rbdSpecBreadth('Y')).toBe(1)
    expect(rbdSpecBreadth('Y,B,M')).toBe(3)
  })

  it('reports an unrestricted spec as Infinity, so it sorts LAST', () => {
    // 0 here would make "any class" the most specific rule in the system and
    // invert the resolver's entire precedence ladder.
    expect(rbdSpecBreadth(null)).toBe(Number.POSITIVE_INFINITY)
    expect(rbdSpecBreadth('')).toBe(Number.POSITIVE_INFINITY)
  })

  it('sorts narrower specs ahead of broader ones', () => {
    const ranked = ['Y,B,M', null, 'Y'].sort((a, b) => rbdSpecBreadth(a) - rbdSpecBreadth(b))
    expect(ranked).toEqual(['Y', 'Y,B,M', null])
  })
})

describe('formatRbdSpec', () => {
  it('normalises however it was typed', () => {
    expect(formatRbdSpec('y/b , m')).toBe('B, M, Y')
  })

  it('says "Any class" rather than showing an empty string', () => {
    expect(formatRbdSpec(null)).toBe('Any class')
  })
})
