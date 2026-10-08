import { describe, it, expect } from 'vitest'
import { reachIndex, type ReachRow } from './reachIndex'

// The index must return exactly what the per-client filter it replaced did,
// in the same order -- resolution breaks ties by order.
function oldFilter<T extends ReachRow>(rows: T[], clientId: string, groupId: string | null, bucketIds: string[]): T[] {
  return rows.filter(a => {
    if (a.kind === 'client') return a.client_id === clientId
    if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
    return a.client_group_id !== null && a.client_group_id === groupId
  })
}

describe('reachIndex', () => {
  it('matches the per-client filter, row for row and in order', () => {
    // Deterministic pseudo-random rows over 30 clients, 5 groups, 8 buckets.
    let seed = 7
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
    const rows = Array.from({ length: 500 }, (_, i) => {
      const k = next(3)
      return {
        id: i,
        kind: k === 0 ? 'client' : k === 1 ? 'client_group' : 'bucket',
        client_id: k === 0 ? `c${next(30)}` : null,
        client_group_id: k === 1 ? `g${next(5)}` : null,
        bucket_id: k === 2 ? `b${next(8)}` : null,
      }
    })
    const reaching = reachIndex(rows)
    for (let c = 0; c < 30; c++) {
      const group = c % 6 === 5 ? null : `g${c % 5}`
      const buckets = [`b${c % 8}`, `b${(c * 3) % 8}`].filter((b, i, all) => all.indexOf(b) === i)
      expect(reaching(`c${c}`, group, buckets)).toEqual(oldFilter(rows, `c${c}`, group, buckets))
    }
  })

  it('a client reached by nothing gets nothing', () => {
    expect(reachIndex([{ kind: 'client', client_id: 'a', client_group_id: null, bucket_id: null }])('z', null, [])).toEqual([])
  })
})
