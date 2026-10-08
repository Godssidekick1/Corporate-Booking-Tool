// ── reachIndex ───────────────────────────────────────────────────────────────
// Which assignments (deal codes, forms of payment, commercial rules) reach a
// client: assigned to the client, to its client group, or to a bucket it is in.
//
// For the coverage reports, which answer that for EVERY client of a TMC. They
// used to filter the whole assignment list once per client -- clients x
// assignments checks, 21 s at 10,000 clients and 50,000 assignments (npm run
// scale). Indexing the list once by target makes it clients + assignments.
//
// Same rows as the old filter, in the same (original) order, so resolution and
// its tie-breaking are unchanged. A single client's booking asks the database
// instead (app/lib/db/fragments.ts `reaching`).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReachRow {
  kind: string
  client_id: string | null
  client_group_id: string | null
  bucket_id: string | null
}

export function reachIndex<T extends ReachRow>(rows: readonly T[]) {
  const byClient = new Map<string, number[]>()
  const byGroup = new Map<string, number[]>()
  const byBucket = new Map<string, number[]>()
  const add = (map: Map<string, number[]>, key: string | null, i: number) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(i)
    else map.set(key, [i])
  }
  rows.forEach((r, i) => {
    if (r.kind === 'client') add(byClient, r.client_id, i)
    else if (r.kind === 'bucket') add(byBucket, r.bucket_id, i)
    else add(byGroup, r.client_group_id, i)
  })

  return function reaching(clientId: string, groupId: string | null, bucketIds: readonly string[]): T[] {
    const hits = [
      ...(byClient.get(clientId) ?? []),
      ...(groupId ? byGroup.get(groupId) ?? [] : []),
      ...bucketIds.flatMap(b => byBucket.get(b) ?? []),
    ]
    return [...new Set(hits)].sort((a, b) => a - b).map(i => rows[i])
  }
}
