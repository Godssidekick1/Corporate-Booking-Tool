import { describe, it, expect } from 'vitest'
import {
  resolveCommercials,
  type ResolvableRule,
  type ResolvableAssignment,
} from './resolveCommercials'
import type { CommercialKind } from './calcOnByKind'

// ── resolveCommercials ───────────────────────────────────────────────────────
// Which markup, which discount and which processing fee apply to one priced
// itinerary for one client. It decides money, so every branch below is a
// billing decision.
//
// ONE WINNER PER KIND. Overlap is the everyday case -- a TMC-wide markup
// alongside an airline-specific one -- so the function RANKS rather than
// rejects, and the order of the tie-breaks IS the commercial policy.
//
// The ladder, most decisive first:
//   1. assignment kind   client > bucket > client_group
//   2. airline           a named airline beats "any airline"
//   3. cabin             a named cabin beats "any cabin"
//   4. RBD breadth       fewer classes beats more (unrestricted is Infinity)
//   5. fare type         a named type beats "all"
//   6. recency           most recently created wins
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0

function rule(overrides: Partial<ResolvableRule> = {}): ResolvableRule {
  seq += 1
  return {
    id: `rule-${seq}`,
    kind: 'markup',
    category_id: 'cat-dom-bsp',
    airline_code: null,
    cabin: null,
    rbd_spec: null,
    fare_type: 'all',
    calc_type: 'percent',
    calc_on: 'bf',
    rate: 5,
    calc_basis: null,
    exclude_tax_codes: null,
    include_ssr: null,
    active: true,
    valid_from: null,
    valid_to: null,
    // Ascending with seq, so a later-declared fixture is the more recent one.
    created_at: `2026-01-${String(seq).padStart(2, '0')}T00:00:00Z`,
    ...overrides,
  }
}

function assign(r: ResolvableRule, kind: ResolvableAssignment['kind'] = 'client', viaName: string | null = null): ResolvableAssignment {
  return { rule_id: r.id, kind, via_name: viaName }
}

const ALL_KINDS = new Set<CommercialKind>(['markup', 'discount', 'processing_fee'])

describe('resolveCommercials — one winner per kind', () => {
  it('resolves each kind independently', () => {
    const m = rule({ kind: 'markup' })
    const d = rule({ kind: 'discount' })
    const f = rule({ kind: 'processing_fee' })

    const out = resolveCommercials({
      rules: [m, d, f],
      assignments: [assign(m), assign(d), assign(f)],
      enabledKinds: ALL_KINDS,
    })

    expect(out.markup?.rule.id).toBe(m.id)
    expect(out.discount?.rule.id).toBe(d.id)
    expect(out.processing_fee?.rule.id).toBe(f.id)
  })

  it('returns null for a kind with no rule', () => {
    const m = rule({ kind: 'markup' })
    const out = resolveCommercials({ rules: [m], assignments: [assign(m)], enabledKinds: ALL_KINDS })

    expect(out.markup).not.toBeNull()
    expect(out.discount).toBeNull()
    expect(out.processing_fee).toBeNull()
  })
})

describe('resolveCommercials — the precedence ladder', () => {
  it('a direct client assignment beats a bucket, which beats a client group', () => {
    const viaGroup = rule()
    const viaBucket = rule()
    const direct = rule()

    const out = resolveCommercials({
      rules: [viaGroup, viaBucket, direct],
      assignments: [
        assign(viaGroup, 'client_group', 'Enterprise'),
        assign(viaBucket, 'bucket', 'Corps with vibes'),
        assign(direct, 'client'),
      ],
      enabledKinds: ALL_KINDS,
    })

    expect(out.markup?.rule.id).toBe(direct.id)
    expect(out.markup?.via).toBe('Direct assignment')
    // The losers are reported, so an admin can see why the rule they expected
    // is not the one in force.
    expect(out.markup?.beat).toHaveLength(2)
  })

  it('an airline-specific rule beats an any-airline rule', () => {
    const generic = rule()
    const specific = rule({ airline_code: 'AI' })

    const out = resolveCommercials({
      rules: [generic, specific],
      assignments: [assign(generic), assign(specific)],
      airlineCode: 'AI',
      enabledKinds: ALL_KINDS,
    })

    expect(out.markup?.rule.id).toBe(specific.id)
  })

  it('a cabin-specific rule beats an any-cabin rule', () => {
    const generic = rule()
    const specific = rule({ cabin: 'Y' })

    const out = resolveCommercials({
      rules: [generic, specific],
      assignments: [assign(generic), assign(specific)],
      cabin: 'Y',
      enabledKinds: ALL_KINDS,
    })

    expect(out.markup?.rule.id).toBe(specific.id)
  })

  it('a narrower booking-class set beats a broader one', () => {
    const broad = rule({ rbd_spec: 'Y,B,M' })
    const narrow = rule({ rbd_spec: 'Y' })

    const out = resolveCommercials({
      rules: [broad, narrow],
      assignments: [assign(broad), assign(narrow)],
      legBookingCodes: ['Y'],
      enabledKinds: ALL_KINDS,
    })

    expect(out.markup?.rule.id).toBe(narrow.id)
  })

  it('falls back to recency when nothing else separates two rules', () => {
    const older = rule()
    const newer = rule()

    const out = resolveCommercials({
      rules: [older, newer],
      assignments: [assign(older), assign(newer)],
      enabledKinds: ALL_KINDS,
    })

    // Commercial terms get renegotiated; the new one is nearly always intended.
    expect(out.markup?.rule.id).toBe(newer.id)
  })

  it('flags two rules the ladder genuinely cannot separate', () => {
    const a = rule({ created_at: '2026-01-01T00:00:00Z' })
    const b = rule({ created_at: '2026-01-01T00:00:00Z' })

    const out = resolveCommercials({
      rules: [a, b],
      assignments: [assign(a), assign(b)],
      enabledKinds: ALL_KINDS,
    })

    // Surfaced rather than silently picked: the wrong answer is a wrongly
    // billed booking.
    expect(out.markup?.ambiguous).toBe(true)
  })
})

describe('resolveCommercials — what excludes a rule', () => {
  it('excludes a kind switched off in Corporate Settings', () => {
    const m = rule({ kind: 'markup' })
    const out = resolveCommercials({
      rules: [m],
      assignments: [assign(m)],
      enabledKinds: new Set<CommercialKind>(['discount', 'processing_fee']),
    })

    expect(out.markup).toBeNull()
    expect(out.trace[0].rejectedBy).toBe('kind_switched_off')
  })

  it('excludes an inactive rule', () => {
    const m = rule({ active: false })
    const out = resolveCommercials({ rules: [m], assignments: [assign(m)], enabledKinds: ALL_KINDS })

    expect(out.markup).toBeNull()
    expect(out.trace[0].rejectedBy).toBe('not_active')
  })

  it('excludes a rule outside its validity window', () => {
    const expired = rule({ valid_from: '2025-01-01', valid_to: '2025-12-31' })
    const out = resolveCommercials({
      rules: [expired],
      assignments: [assign(expired)],
      pricedOn: '2026-06-01',
      enabledKinds: ALL_KINDS,
    })

    expect(out.markup).toBeNull()
    expect(out.trace[0].rejectedBy).toBe('outside_validity')
  })

  it('excludes a rule filed for a different airline', () => {
    const m = rule({ airline_code: '6E' })
    const out = resolveCommercials({
      rules: [m],
      assignments: [assign(m)],
      airlineCode: 'AI',
      enabledKinds: ALL_KINDS,
    })

    expect(out.markup).toBeNull()
    expect(out.trace[0].rejectedBy).toBe('airline')
    // The detail names BOTH sides -- a reason carrying only the field name
    // sends someone back to the editor to guess.
    expect(out.trace[0].detail).toContain('6E')
    expect(out.trace[0].detail).toContain('AI')
  })

  it('excludes a rule filed for a different cabin', () => {
    const m = rule({ cabin: 'C' })
    const out = resolveCommercials({
      rules: [m],
      assignments: [assign(m)],
      cabin: 'Y',
      enabledKinds: ALL_KINDS,
    })

    expect(out.trace[0].rejectedBy).toBe('cabin')
  })

  it('excludes a rule whose classes do not cover EVERY leg', () => {
    // The single commonest reason a correct-looking rule never fires: Y is the
    // full-fare economy bucket, and discounted fares sell in S and T.
    const m = rule({ rbd_spec: 'Y,B,M' })
    const out = resolveCommercials({
      rules: [m],
      assignments: [assign(m)],
      legBookingCodes: ['S', 'T'],
      enabledKinds: ALL_KINDS,
    })

    expect(out.markup).toBeNull()
    expect(out.trace[0].rejectedBy).toBe('booking_class')
    expect(out.trace[0].detail).toContain('S, T')
  })

  it('excludes a rule filed for a different fare type', () => {
    const m = rule({ fare_type: 'corporate' })
    const out = resolveCommercials({
      rules: [m],
      assignments: [assign(m)],
      fareType: 'retail',
      enabledKinds: ALL_KINDS,
    })

    expect(out.trace[0].rejectedBy).toBe('fare_type')
  })

  it('treats an unsupplied dimension as permissive', () => {
    // The coverage view resolves with no itinerary at all -- "what could this
    // client get" -- so a restricted rule is still a candidate there.
    const m = rule({ airline_code: 'AI', cabin: 'C', rbd_spec: 'Y' })
    const out = resolveCommercials({ rules: [m], assignments: [assign(m)], enabledKinds: ALL_KINDS })

    expect(out.markup?.rule.id).toBe(m.id)
  })
})

describe('resolveCommercials — the trace', () => {
  it('reports one entry per assigned rule, win or lose', () => {
    const winner = rule()
    const loser = rule({ airline_code: '6E' })

    const out = resolveCommercials({
      rules: [winner, loser],
      assignments: [assign(winner), assign(loser)],
      airlineCode: 'AI',
      enabledKinds: ALL_KINDS,
    })

    expect(out.trace).toHaveLength(2)
    expect(out.trace.find(t => t.ruleId === winner.id)?.won).toBe(true)
    expect(out.trace.find(t => t.ruleId === loser.id)?.won).toBe(false)
  })

  it('distinguishes "never matched" from "matched but was outranked"', () => {
    // Different problems, different fixes -- and they look identical on screen
    // without this.
    const winner = rule({ airline_code: 'AI' })
    const outranked = rule()

    const out = resolveCommercials({
      rules: [winner, outranked],
      assignments: [assign(winner), assign(outranked)],
      airlineCode: 'AI',
      enabledKinds: ALL_KINDS,
    })

    const loserTrace = out.trace.find(t => t.ruleId === outranked.id)!
    expect(loserTrace.rejectedBy).toBeNull()
    expect(loserTrace.detail).toContain('outranked')
  })

  it('is empty when no rule reaches the client at all', () => {
    const out = resolveCommercials({ rules: [], assignments: [], enabledKinds: ALL_KINDS })
    expect(out.trace).toEqual([])
  })

  it('keeps the STRONGEST claim when one rule is assigned twice', () => {
    // Directly and via a bucket, say. The same rule must not compete with
    // itself.
    const r = rule()
    const out = resolveCommercials({
      rules: [r],
      assignments: [assign(r, 'bucket', 'Corps'), assign(r, 'client')],
      enabledKinds: ALL_KINDS,
    })

    expect(out.trace).toHaveLength(1)
    expect(out.markup?.via).toBe('Direct assignment')
    expect(out.markup?.beat).toHaveLength(0)
  })
})
