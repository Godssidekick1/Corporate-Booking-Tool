import { describe, it, expect } from 'vitest'
import { resolveApproverForTier, type ChainTier } from './resolveApprovalTier'
import { fakeDb, type FakeTables } from './fakeDb'

// ── resolveApproverForTier ───────────────────────────────────────────────────
// Who gets ASKED to approve someone else's spend. Every branch here decides
// that, and this function has already been wrong in production twice:
//
//   * 'any_manager_at' embedded `bands:band_code(rank)` across a foreign key
//     that does not exist. PostgREST answered 400 PGRST200, the caller
//     discarded the error, and the branch resolved nobody -- ever.
//
//   * the same branch once returned `qualifying[0]?.id ?? null` instead of a
//     resolution object. It type-checked only because the id came back as
//     `any`, and at runtime inserted approver_id: undefined.
//
// Both were invisible to a route test that asserted a 200, because both
// produced a plausible "no approver found" rather than a failure.
// ─────────────────────────────────────────────────────────────────────────────

type Service = Parameters<typeof resolveApproverForTier>[0]

const CLIENT = 'client-1'

function svc(tables: FakeTables): Service {
  // Cast because QueryBuilder carries private fields and so cannot be matched
  // structurally. The stand-in implements the surface this function uses, and
  // throws on anything it does not.
  return fakeDb(tables) as unknown as Service
}

function tier(overrides: Partial<ChainTier> = {}): ChainTier {
  return { tier: 1, approver_type: 'any_manager_at', min_verdict: 'amber', ...overrides }
}

// created_at is what breaks a rank tie, so it is explicit in every fixture
// rather than defaulted to something the test does not show.
function manager(
  id: string,
  band: string | null,
  createdAt: string,
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    band_code: band,
    created_at: createdAt,
    client_id: CLIENT,
    role: 'manager',
    status: 'active',
    ...extra,
  }
}

const BANDS = [
  { client_id: CLIENT, code: 'L1', rank: 1 },
  { client_id: CLIENT, code: 'L2', rank: 2 },
  { client_id: CLIENT, code: 'L4', rank: 4 },
  { client_id: CLIENT, code: 'L5', rank: 5 },
]

describe('resolveApproverForTier — rank resolution', () => {
  it('picks the LOWEST qualifying rank, not the most senior person', async () => {
    // The stated design intent: the approver closest in seniority to the
    // traveller. Always escalating to the most senior person available would
    // put every booking in front of the same director.
    const result = await resolveApproverForTier(
      svc({
        employees: [
          manager('m-l5', 'L5', '2024-01-01'),
          manager('m-l4', 'L4', '2024-01-01'),
          manager('m-l2', 'L2', '2024-01-01'),
        ],
        bands: BANDS,
      }),
      tier({ min_band_rank: 2 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'm-l2' })
  })

  it('excludes anyone below min_band_rank', async () => {
    const result = await resolveApproverForTier(
      svc({
        employees: [manager('m-l1', 'L1', '2024-01-01'), manager('m-l4', 'L4', '2024-01-01')],
        bands: BANDS,
      }),
      tier({ min_band_rank: 4 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'm-l4' })
  })

  it('is unresolved when nobody meets the rank', async () => {
    // Not an error, and not a free pass: the tier is real and the people are
    // not there. raiseApprovals decides what to do about that.
    const result = await resolveApproverForTier(
      svc({ employees: [manager('m-l1', 'L1', '2024-01-01')], bands: BANDS }),
      tier({ min_band_rank: 5 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('treats a missing min_band_rank as 0, so any ranked manager qualifies', async () => {
    const result = await resolveApproverForTier(
      svc({ employees: [manager('m-l1', 'L1', '2024-01-01')], bands: BANDS }),
      tier({ min_band_rank: null }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'm-l1' })
  })

  it('EXCLUDES a manager whose band_code matches no band', async () => {
    // rank falls to -1, which fails `>= 0`. Excluding is the safe direction: a
    // manager whose band was renamed or deleted should not silently satisfy a
    // rank requirement they may no longer meet.
    const result = await resolveApproverForTier(
      svc({ employees: [manager('m-ghost', 'L9_DELETED', '2024-01-01')], bands: BANDS }),
      tier({ min_band_rank: 0 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('excludes a manager with no band at all', async () => {
    const result = await resolveApproverForTier(
      svc({ employees: [manager('m-none', null, '2024-01-01')], bands: BANDS }),
      tier({ min_band_rank: 0 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('counts admins as well as managers', async () => {
    const result = await resolveApproverForTier(
      svc({
        employees: [manager('a-1', 'L4', '2024-01-01', { role: 'admin' })],
        bands: BANDS,
      }),
      tier({ min_band_rank: 1 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'a-1' })
  })

  it('ignores inactive managers and other clients entirely', async () => {
    const result = await resolveApproverForTier(
      svc({
        employees: [
          manager('m-inactive', 'L2', '2024-01-01', { status: 'deactivated' }),
          manager('m-other-client', 'L2', '2024-01-01', { client_id: 'client-2' }),
          manager('m-ok', 'L4', '2024-01-01'),
        ],
        bands: BANDS,
      }),
      tier({ min_band_rank: 1 }),
      'traveller-1',
      CLIENT
    )

    // Both excluded rows carry a LOWER rank than m-ok, so if either leaked
    // through the filters it would win the sort and be returned instead.
    expect(result).toEqual({ kind: 'approver', approverId: 'm-ok' })
  })

  it('reads ranks from this client\'s bands, not another client\'s', async () => {
    // band codes are per-client text. Two clients both having an "L4" that
    // means different things is normal, and resolving rank from the wrong
    // client would let a rank requirement be met by accident.
    const result = await resolveApproverForTier(
      svc({
        employees: [manager('m-1', 'L4', '2024-01-01')],
        bands: [{ client_id: 'client-2', code: 'L4', rank: 4 }],
      }),
      tier({ min_band_rank: 1 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })
})

describe('resolveApproverForTier — the tie-break', () => {
  // Rank alone is not a total order: two active managers commonly share a band.
  // The query carries no ORDER BY, so rows arrive in whatever order PostgreSQL
  // scans them, which changes after an UPDATE moves a row or a VACUUM repacks
  // the page. Without a tie-break the chosen approver is arbitrary AND unstable
  // over time, with no configuration having changed.

  const tied = [
    manager('m-newer', 'L4', '2024-06-01'),
    manager('m-older', 'L4', '2024-01-01'),
    manager('m-middle', 'L4', '2024-03-01'),
  ]

  it('breaks a rank tie by longest-serving', async () => {
    const result = await resolveApproverForTier(
      svc({ employees: tied, bands: BANDS }),
      tier({ min_band_rank: 1 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'm-older' })
  })

  it('gives the SAME answer whatever order the rows arrive in', async () => {
    // The property that actually matters. All six permutations of three tied
    // managers, every one of which a sequential scan could legitimately hand
    // back on a different day.
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]

    const answers = new Set<string>()
    for (const order of permutations) {
      const result = await resolveApproverForTier(
        svc({ employees: order.map(i => tied[i]), bands: BANDS }),
        tier({ min_band_rank: 1 }),
        'traveller-1',
        CLIENT
      )
      answers.add((result as { approverId: string }).approverId)
    }

    expect([...answers]).toEqual(['m-older'])
  })

  it('falls through to id when rank AND created_at are identical', async () => {
    // Two people onboarded in the same bulk import share a timestamp exactly,
    // so created_at is not a total order either.
    const sameInstant = [
      manager('m-bbb', 'L4', '2024-01-01T00:00:00.000Z'),
      manager('m-aaa', 'L4', '2024-01-01T00:00:00.000Z'),
    ]

    const forwards = await resolveApproverForTier(
      svc({ employees: sameInstant, bands: BANDS }), tier({ min_band_rank: 1 }), 't', CLIENT
    )
    const backwards = await resolveApproverForTier(
      svc({ employees: [...sameInstant].reverse(), bands: BANDS }), tier({ min_band_rank: 1 }), 't', CLIENT
    )

    expect(forwards).toEqual({ kind: 'approver', approverId: 'm-aaa' })
    expect(backwards).toEqual(forwards)
  })
})

describe('resolveApproverForTier — the other approver types', () => {
  it('specific_user resolves to the named person', async () => {
    const result = await resolveApproverForTier(
      svc({}),
      tier({ approver_type: 'specific_user', approver_user_id: 'u-7' }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'u-7' })
  })

  it('specific_user with nobody named is unresolved, not a crash', async () => {
    const result = await resolveApproverForTier(
      svc({}),
      tier({ approver_type: 'specific_user', approver_user_id: null }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('manager resolves to the traveller\'s own manager_id', async () => {
    const result = await resolveApproverForTier(
      svc({ employees: [{ id: 'traveller-1', manager_id: 'boss-1', top_of_hierarchy: false }] }),
      tier({ approver_type: 'manager' }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'boss-1' })
  })

  it('the person at the top of the hierarchy needs no approval, rather than being a misconfiguration', async () => {
    // The distinction the three-outcome type exists for. Reporting this as
    // unresolved would mean the owner of a client could never have a clean
    // approval setup; blocking would hold their bookings forever.
    const result = await resolveApproverForTier(
      svc({ employees: [{ id: 'ceo', manager_id: null, top_of_hierarchy: true }] }),
      tier({ approver_type: 'manager' }),
      'ceo',
      CLIENT
    )

    expect(result).toEqual({
      kind: 'no_approval_needed',
      reason: 'no manager to approve — this employee is at the top of the hierarchy',
    })
  })

  it('no manager and NOT top of hierarchy is a configuration gap', async () => {
    const result = await resolveApproverForTier(
      svc({ employees: [{ id: 'orphan', manager_id: null, top_of_hierarchy: false }] }),
      tier({ approver_type: 'manager' }),
      'orphan',
      CLIENT
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('finance_role picks the longest-serving active finance person', async () => {
    const result = await resolveApproverForTier(
      svc({
        employees: [
          { id: 'f-new', client_id: CLIENT, role: 'finance', status: 'active', created_at: '2024-06-01' },
          { id: 'f-old', client_id: CLIENT, role: 'finance', status: 'active', created_at: '2024-01-01' },
        ],
      }),
      tier({ approver_type: 'finance_role' }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'f-old' })
  })

  it('admin resolves against role admin, not finance', async () => {
    const result = await resolveApproverForTier(
      svc({
        employees: [
          { id: 'f-1', client_id: CLIENT, role: 'finance', status: 'active', created_at: '2024-01-01' },
          { id: 'a-1', client_id: CLIENT, role: 'admin', status: 'active', created_at: '2024-02-01' },
        ],
      }),
      tier({ approver_type: 'admin' }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'a-1' })
  })

  it('an unbound step is unresolved rather than silently approving', async () => {
    // 'unbound' is what a step becomes when this client has not said who fills
    // it. Falling through to no_approval_needed would let an unconfigured tier
    // wave spend through.
    const result = await resolveApproverForTier(
      svc({}), tier({ approver_type: 'unbound' }), 'traveller-1', CLIENT
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })
})

describe('resolveApproverForTier — characterisation, not endorsement', () => {
  it('CURRENTLY lets a manager resolve as their own approver', async () => {
    // Recorded, not endorsed. 'any_manager_at' filters by client, role, status
    // and rank -- it does NOT exclude the traveller. A manager booking their
    // own travel can therefore be selected to approve it.
    //
    // There is a separate 'self' approver type, which suggests self-approval is
    // meant to be an explicit choice rather than something reachable by
    // accident. Whether to exclude the traveller here is a product decision, so
    // this pins the current behaviour and fails loudly if it changes by
    // accident rather than on purpose.
    const result = await resolveApproverForTier(
      svc({ employees: [manager('traveller-1', 'L4', '2024-01-01')], bands: BANDS }),
      tier({ min_band_rank: 1 }),
      'traveller-1',
      CLIENT
    )

    expect(result).toEqual({ kind: 'approver', approverId: 'traveller-1' })
  })
})
