// ── Foreign-key relationships, hand-declared ─────────────────────────────────
// PostgREST reads pg_catalog at boot and builds a relationship graph, which is
// how `select('id, clients(tmc_id)')` resolves without naming a join column.
// The shim has no such catalogue, so the handful of relationships the codebase
// actually embeds are declared here.
//
// HAND-WRITTEN RATHER THAN GENERATED, deliberately. There are 60+ foreign keys
// in baseline.sql and the codebase embeds across exactly four of them. A
// generated map would imply the other 56 are supported and tested; they are
// not. Anything absent here fails loudly at the call site, which is the
// behaviour we want -- see the `bands:band_code(rank)` incident, where an embed
// across a NON-EXISTENT foreign key returned 400 from PostgREST for months and
// the error was discarded by the caller.
//
// Keyed by [table being queried][name used in the select string]. The name is
// usually the foreign table, which is what PostgREST defaults to.
// ─────────────────────────────────────────────────────────────────────────────

export interface Relationship {
  // The table to join.
  table: string
  // Column on the queried table holding the reference.
  localColumn: string
  // Column on the foreign table it matches.
  foreignColumn: string
}

export const RELATIONSHIPS: Record<string, Record<string, Relationship>> = {
  // app/api/tmc/clients/route.ts:50 -- the clients list embeds the group's code
  // and the branch's number so the table does not need two more queries.
  clients: {
    client_groups: { table: 'client_groups', localColumn: 'client_group_id', foreignColumn: 'id' },
    branches: { table: 'branches', localColumn: 'branch_id', foreignColumn: 'id' },
  },

  // app/api/tmc/clients/[id]/buckets/route.ts:64 and :138 -- the join table's
  // rows are immediately mapped to the bucket itself.
  bucket_clients: {
    buckets: { table: 'buckets', localColumn: 'bucket_id', foreignColumn: 'id' },
  },

  // app/api/tmc/forms-of-payment/route.ts:414 -- `clients!inner(tmc_id)`, the
  // one INNER join in the codebase. Used to check that an employee's client
  // belongs to the caller's TMC, one hop further than the sibling checks above
  // it in that file.
  employees: {
    clients: { table: 'clients', localColumn: 'client_id', foreignColumn: 'id' },
  },
}

export function findRelationship(table: string, name: string): Relationship | null {
  return RELATIONSHIPS[table]?.[name] ?? null
}
