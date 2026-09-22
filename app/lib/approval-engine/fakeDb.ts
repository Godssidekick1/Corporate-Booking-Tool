// ── An in-memory stand-in for the data client, for tests ─────────────────────
// The approval engine's decisions are pure functions of the rows it reads, but
// it reads them through a client, so testing those decisions needs something
// that answers .from(...).eq(...).in(...) with rows you chose.
//
// WHY NOT A REAL DATABASE: these are decisions about who may approve someone
// else's spend, and the interesting cases are shapes that barely occur in
// seeded data -- two managers tied on rank, a manager whose band was renamed,
// an employee at the top of the hierarchy. Constructing those in cbt_local
// means writing and cleaning up rows in tables the rest of the suite reads,
// and the test then proves nothing about the decision that the fixture did not
// already decide.
//
// WHY NOT vi.mock: a mock asserts which calls were made. What matters here is
// the ANSWER, and a hand-written filter keeps the test readable as data in,
// verdict out.
//
// This is deliberately NOT a general query engine. It implements the operators
// the approval engine actually uses and throws on anything else, so a query
// that grows a new filter fails loudly here instead of silently ignoring it
// and returning rows the real database would have excluded.
// ─────────────────────────────────────────────────────────────────────────────

export type FakeRow = Record<string, unknown>

interface Awaitable<T> {
  then(onfulfilled: (value: { data: T; error: null }) => unknown): unknown
}

export interface FakeTables {
  [table: string]: FakeRow[]
}

function builderFor(table: string, source: FakeRow[]) {
  let rows = [...source]

  const builder = {
    // Column projection is ignored: the engine reads properties off the rows,
    // and a stand-in that also trimmed them would only test the fixture.
    // The real allow-list rejects an unknown column, which is what guards that.
    select() {
      return builder
    },
    eq(column: string, value: unknown) {
      rows = rows.filter(r => r[column] === value)
      return builder
    },
    in(column: string, values: unknown[]) {
      rows = rows.filter(r => values.includes(r[column]))
      return builder
    },
    order(column: string, options?: { ascending?: boolean }) {
      const ascending = options?.ascending !== false
      rows.sort((a, b) => {
        const x = a[column] as string | number
        const y = b[column] as string | number
        if (x === y) return 0
        return (x < y ? -1 : 1) * (ascending ? 1 : -1)
      })
      return builder
    },
    limit(n: number) {
      rows = rows.slice(0, n)
      return builder
    },
    maybeSingle(): Awaitable<FakeRow | null> {
      return { then: (resolve) => resolve({ data: rows[0] ?? null, error: null }) }
    },
    single(): Awaitable<FakeRow | null> {
      return { then: (resolve) => resolve({ data: rows[0] ?? null, error: null }) }
    },
    then(resolve: (value: { data: FakeRow[]; error: null }) => unknown) {
      return resolve({ data: rows, error: null })
    },
  }

  // Anything the engine calls that is not implemented above is a gap in this
  // stand-in, not a passing test. Named so the failure says which one.
  return new Proxy(builder, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      throw new Error(`[fakeDb] ${table}: .${String(prop)}() is not implemented`)
    },
  })
}

export function fakeDb(tables: FakeTables) {
  return {
    from(table: string) {
      return builderFor(table, tables[table] ?? [])
    },
  }
}
