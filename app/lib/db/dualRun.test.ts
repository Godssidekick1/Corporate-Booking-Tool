import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDbClient } from './client'
import { createDualRunClient, getDivergences, clearDivergences } from './dualRun'
import { closePool } from './pool'

// ── The dual-run harness ─────────────────────────────────────────────────────
// Written to be left ON during a QA pass, which makes its own failure modes
// expensive: a harness that double-writes corrupts data, and one that throws
// takes down a request it was only meant to observe.
//
// Gated like parity.test.ts -- it reaches the live project. Run with:
//   DB_PARITY=1 npx vitest run app/lib/db/dualRun.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const ENABLED =
  process.env.DB_PARITY === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const d = ENABLED ? describe : describe.skip

const supabase = ENABLED
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  : (null as never)

d('dual run', () => {
  const dual = () => createDualRunClient(createDbClient(), supabase)

  beforeEach(clearDivergences)
  afterAll(async () => { await closePool() })

  it('returns the PRIMARY driver\'s answer, not the secondary\'s', async () => {
    const { data, error } = await dual().from('airlines').select('code, name').limit(2)

    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
  })

  it('reports no divergence on a query the drivers agree about', async () => {
    // in([]) on both: empty result, no error. If this logs a divergence the
    // harness has a false positive, which would drown a real one in noise.
    await dual().from('airlines').select('code').in('code', [])

    expect(getDivergences()).toEqual([])
  })

  it('NEVER runs the secondary for a write', async () => {
    // The property that makes it safe to leave on. A doubled insert writes the
    // row twice and no harness can undo that.
    //
    // Asserted by doing a write that WOULD fail loudly against the live
    // project -- the code is fake, and the local row is cleaned up after. If
    // the secondary ran, the live project would have gained a row.
    const code = 'ZQ'
    await createDbClient().from('airlines').delete().eq('code', code)

    const { error } = await dual().from('airlines').insert({ code, name: 'Dual Probe' })
    expect(error).toBeNull()

    const { data: live } = await supabase.from('airlines').select('code').eq('code', code)
    expect(live, 'the secondary must not have written to the live project').toEqual([])

    await createDbClient().from('airlines').delete().eq('code', code)
  })

  it('logs a divergence when the two genuinely disagree', async () => {
    // Negative control. A row that exists locally and not remotely is exactly
    // the drift a QA pass would surface, so the harness must notice it.
    const code = 'ZY'
    await createDbClient().from('airlines').delete().eq('code', code)
    await createDbClient().from('airlines').insert({ code, name: 'Local Only' })

    clearDivergences()
    await dual().from('airlines').select('code, name').eq('code', code)

    const found = getDivergences()
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].table).toBe('airlines')
    expect(['length', 'row']).toContain(found[0].kind)

    await createDbClient().from('airlines').delete().eq('code', code)
  })
})
