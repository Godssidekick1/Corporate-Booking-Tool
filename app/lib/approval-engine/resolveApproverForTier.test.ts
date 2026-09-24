import { describe, it, expect } from 'vitest'
import { pickApprover, type ChainTier, type ApproverFacts } from './resolveApprovalTier'

// ── pickApprover ─────────────────────────────────────────────────────────────
// Who gets ASKED to approve someone else's spend. Every branch here decides
// that, and this logic has already been wrong in production twice:
//
//   * 'any_manager_at' embedded `bands:band_code(rank)` across a foreign key
//     that does not exist. PostgREST answered 400 PGRST200, the caller
//     discarded the error, and the branch resolved nobody -- ever.
//
//   * the same branch once returned `qualifying[0]?.id ?? null` instead of a
//     resolution object. It type-checked only because the id came back as
//     `any`, and at runtime inserted approver_id: undefined.
//
// Pure: the facts are handed in. WHICH rows are candidates (active, at this
// client, manager or admin, this client's bands) is the repository's SQL and
// is tested against the database in tests/lib/approverCandidates.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

function tier(overrides: Partial<ChainTier> = {}): ChainTier {
  return { tier: 1, approver_type: 'any_manager_at', min_verdict: 'amber', ...overrides }
}

// created_at is what breaks a rank tie, so it is explicit in every fixture
// rather than defaulted to something the test does not show.
function manager(id: string, band: string | null, createdAt: string) {
  return { id, band_code: band, created_at: createdAt }
}

const RANKS = new Map([['L1', 1], ['L2', 2], ['L4', 4], ['L5', 5]])

const ranked = (candidates: ReturnType<typeof manager>[]): ApproverFacts => ({ candidates, rankByCode: RANKS })

describe('pickApprover — rank resolution', () => {
  it('picks the LOWEST qualifying rank, not the most senior person', () => {
    // The stated design intent: the approver closest in seniority to the
    // traveller. Always escalating to the most senior person available would
    // put every booking in front of the same director.
    const facts = ranked([
      manager('m-l5', 'L5', '2024-01-01'),
      manager('m-l4', 'L4', '2024-01-01'),
      manager('m-l2', 'L2', '2024-01-01'),
    ])
    expect(pickApprover(tier({ min_band_rank: 2 }), 'traveller-1', facts))
      .toEqual({ kind: 'approver', approverId: 'm-l2' })
  })

  it('excludes anyone below min_band_rank', () => {
    const facts = ranked([manager('m-l1', 'L1', '2024-01-01'), manager('m-l4', 'L4', '2024-01-01')])
    expect(pickApprover(tier({ min_band_rank: 4 }), 'traveller-1', facts))
      .toEqual({ kind: 'approver', approverId: 'm-l4' })
  })

  it('is unresolved when nobody meets the rank', () => {
    // Not an error, and not a free pass: the tier is real and the people are
    // not there. raiseApprovals decides what to do about that.
    expect(pickApprover(tier({ min_band_rank: 5 }), 'traveller-1', ranked([manager('m-l1', 'L1', '2024-01-01')])))
      .toEqual({ kind: 'unresolved' })
  })

  it('treats a missing min_band_rank as 0, so any ranked manager qualifies', () => {
    expect(pickApprover(tier({ min_band_rank: null }), 'traveller-1', ranked([manager('m-l1', 'L1', '2024-01-01')])))
      .toEqual({ kind: 'approver', approverId: 'm-l1' })
  })

  it('EXCLUDES a manager whose band_code matches no band', () => {
    // rank falls to -1, which fails `>= 0`. Excluding is the safe direction: a
    // manager whose band was renamed or deleted should not silently satisfy a
    // rank requirement they may no longer meet.
    expect(pickApprover(tier({ min_band_rank: 0 }), 'traveller-1', ranked([manager('m-ghost', 'L9_DELETED', '2024-01-01')])))
      .toEqual({ kind: 'unresolved' })
  })

  it('excludes a manager with no band at all', () => {
    expect(pickApprover(tier({ min_band_rank: 0 }), 'traveller-1', ranked([manager('m-none', null, '2024-01-01')])))
      .toEqual({ kind: 'unresolved' })
  })

  it('with no candidates or no bands at all, nobody', () => {
    expect(pickApprover(tier({ min_band_rank: 0 }), 't', {})).toEqual({ kind: 'unresolved' })
    expect(pickApprover(tier({ min_band_rank: 0 }), 't', { candidates: [manager('m', 'L4', '2024-01-01')] }))
      .toEqual({ kind: 'unresolved' })
  })
})

describe('pickApprover — the tie-break', () => {
  // Rank alone is not a total order: two active managers commonly share a band.
  // Without a tie-break the chosen approver depends on the order rows arrive
  // in, which is arbitrary AND unstable over time.

  const tied = [
    manager('m-newer', 'L4', '2024-06-01'),
    manager('m-older', 'L4', '2024-01-01'),
    manager('m-middle', 'L4', '2024-03-01'),
  ]

  it('breaks a rank tie by longest-serving', () => {
    expect(pickApprover(tier({ min_band_rank: 1 }), 'traveller-1', ranked(tied)))
      .toEqual({ kind: 'approver', approverId: 'm-older' })
  })

  it('gives the SAME answer whatever order the rows arrive in', () => {
    // All six permutations of three tied managers.
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    const answers = new Set(permutations.map(order =>
      (pickApprover(tier({ min_band_rank: 1 }), 'traveller-1', ranked(order.map(i => tied[i]))) as { approverId: string }).approverId))
    expect([...answers]).toEqual(['m-older'])
  })

  it('falls through to id when rank AND created_at are identical', () => {
    // Two people onboarded in the same bulk import share a timestamp exactly.
    const sameInstant = [
      manager('m-bbb', 'L4', '2024-01-01T00:00:00.000Z'),
      manager('m-aaa', 'L4', '2024-01-01T00:00:00.000Z'),
    ]
    const forwards = pickApprover(tier({ min_band_rank: 1 }), 't', ranked(sameInstant))
    const backwards = pickApprover(tier({ min_band_rank: 1 }), 't', ranked([...sameInstant].reverse()))
    expect(forwards).toEqual({ kind: 'approver', approverId: 'm-aaa' })
    expect(backwards).toEqual(forwards)
  })
})

describe('pickApprover — the other approver types', () => {
  it('specific_user resolves to the named person', () => {
    expect(pickApprover(tier({ approver_type: 'specific_user', approver_user_id: 'u-7' }), 'traveller-1', {}))
      .toEqual({ kind: 'approver', approverId: 'u-7' })
  })

  it('specific_user with nobody named is unresolved, not a crash', () => {
    expect(pickApprover(tier({ approver_type: 'specific_user', approver_user_id: null }), 'traveller-1', {}))
      .toEqual({ kind: 'unresolved' })
  })

  it('manager resolves to the traveller\'s own manager_id', () => {
    expect(pickApprover(tier({ approver_type: 'manager' }), 'traveller-1', {
      reporting: { manager_id: 'boss-1', top_of_hierarchy: false },
    })).toEqual({ kind: 'approver', approverId: 'boss-1' })
  })

  it('the person at the top of the hierarchy needs no approval, rather than being a misconfiguration', () => {
    // The distinction the three-outcome type exists for. Reporting this as
    // unresolved would mean the owner of a client could never have a clean
    // approval setup; blocking would hold their bookings forever.
    expect(pickApprover(tier({ approver_type: 'manager' }), 'ceo', {
      reporting: { manager_id: null, top_of_hierarchy: true },
    })).toEqual({
      kind: 'no_approval_needed',
      reason: 'no manager to approve — this employee is at the top of the hierarchy',
    })
  })

  it('no manager and NOT top of hierarchy is a configuration gap', () => {
    expect(pickApprover(tier({ approver_type: 'manager' }), 'orphan', {
      reporting: { manager_id: null, top_of_hierarchy: false },
    })).toEqual({ kind: 'unresolved' })
    // Nor is a traveller with no employee row at all.
    expect(pickApprover(tier({ approver_type: 'manager' }), 'ghost', { reporting: null }))
      .toEqual({ kind: 'unresolved' })
  })

  it('finance_role and admin resolve to the role holder they are handed', () => {
    expect(pickApprover(tier({ approver_type: 'finance_role' }), 't', { roleHolder: 'f-old' }))
      .toEqual({ kind: 'approver', approverId: 'f-old' })
    expect(pickApprover(tier({ approver_type: 'admin' }), 't', { roleHolder: null }))
      .toEqual({ kind: 'unresolved' })
  })

  it('an unbound step is unresolved rather than silently approving', () => {
    // 'unbound' is what a step becomes when this client has not said who fills
    // it. Falling through to no_approval_needed would let an unconfigured tier
    // wave spend through.
    expect(pickApprover(tier({ approver_type: 'unbound' }), 'traveller-1', {}))
      .toEqual({ kind: 'unresolved' })
  })
})

describe('pickApprover — the traveller qualifying against themselves', () => {
  it('reports no_approval_needed rather than assigning the booking to its own traveller', () => {
    // A manager at the minimum rank IS, by the rule, the approver closest in
    // seniority to themselves. Approving your own booking and needing no
    // approval are the same outcome, so it is reported as the latter.
    expect(pickApprover(tier({ min_band_rank: 1 }), 'traveller-1', ranked([manager('traveller-1', 'L4', '2024-01-01')])))
      .toEqual({
        kind: 'no_approval_needed',
        reason: 'the traveller is themselves the closest qualifying approver at this rank',
      })
  })

  it('still routes to someone else when a CLOSER qualifying approver exists', () => {
    // Self-resolution is a consequence of the seniority rule, not a shortcut
    // around it.
    const facts = ranked([manager('traveller-1', 'L4', '2024-01-01'), manager('m-l2', 'L2', '2024-01-01')])
    expect(pickApprover(tier({ min_band_rank: 1 }), 'traveller-1', facts))
      .toEqual({ kind: 'approver', approverId: 'm-l2' })
  })

  it('does not escalate UPWARD past the traveller', () => {
    // An L2 traveller with only an L4 manager above them needs no approval --
    // it does not escalate to the L4. If that is ever wanted it is a different
    // rule ("someone other than the traveller"), not a bug in this one.
    const facts = ranked([manager('traveller-1', 'L2', '2024-01-01'), manager('m-l4', 'L4', '2024-01-01')])
    expect(pickApprover(tier({ min_band_rank: 1 }), 'traveller-1', facts)).toEqual({
      kind: 'no_approval_needed',
      reason: 'the traveller is themselves the closest qualifying approver at this rank',
    })
  })
})
