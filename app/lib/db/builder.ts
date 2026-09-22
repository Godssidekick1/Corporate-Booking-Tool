import type { Pool, PoolClient } from 'pg'
import { getPool } from './pool'
import { toDbError, notASingleRow, type DbError } from './errors'
import { assertTable, assertColumn, quoteIdent, TABLE_COLUMNS } from './schemaAllowList'

// ── The query builder ────────────────────────────────────────────────────────
// A reimplementation of the part of supabase-js's PostgREST builder that this
// codebase actually uses, over node-postgres.
//
// WHY REIMPLEMENT RATHER THAN MIGRATE: schema/callsites.csv measures the real
// surface at 537 call sites using 19 methods, with a long tail of 32 calls
// across eight rare ones, no `select('*')` anywhere, and `.order()` only ever
// passing `{ ascending: false }`. A surface that small is cheaper to rebuild
// than to rewrite away from -- and rebuilding means the 537 call sites do not
// change at all, so the whole risk of the migration concentrates in this one
// file, where it can be tested directly.
//
// THE CONTRACT, which is what makes the swap invisible:
//   - resolves to { data, error, count }, NEVER throws for a query failure
//   - .maybeSingle() gives null on 0 rows and an ERROR on more than 1
//   - .single() errors unless exactly 1
//   - .in('col', []) returns nothing rather than being a SQL syntax error
//   - errors carry .message/.code/.details/.hint, with pg's SQLSTATE intact
//
// IDENTIFIERS vs VALUES. Values always go through $1/$2 placeholders. Table and
// column names cannot -- PostgreSQL has no placeholder for them -- so every
// identifier is checked against the allow-list generated from the real schema
// before it is concatenated. See schemaAllowList.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface DbResult<T = unknown> {
  data: T
  error: DbError | null
  count: number | null
  status: number
  statusText: string
}

type Mode = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

// "one row" from "array of rows". A builder is generic over what a plain await
// yields; .single() and .maybeSingle() narrow it to the element.
type ElementOf<T> = T extends (infer E)[] ? E : T

interface Condition {
  sql: string
  values: unknown[]
}

// An embedded relation in a select string: `clients(id, name)` or
// `bands:band_code(rank)` or `clients!inner(tmc_id)`. PostgREST resolves these
// against foreign keys; the shim needs them declared, because it has no
// catalogue of relationships at runtime.
export interface EmbedSpec {
  // The property name the rows come back under.
  alias: string
  // The table being joined.
  table: string
  // Columns to select from it.
  columns: string[]
  // Which local column points at it, and which remote column it matches.
  localColumn: string
  foreignColumn: string
  inner: boolean
}

export interface BuilderOptions {
  // Supplied inside withTransaction so every query in the callback runs on one
  // connection. Without it each query takes a fresh client from the pool, which
  // is correct for autocommit and fatal for a transaction.
  client?: PoolClient | null
  // Set by the dual-run harness so it can observe without changing behaviour.
  onQuery?: (info: { table: string; sql: string; values: unknown[] }) => void
}

export class QueryBuilder<T = unknown[]> implements PromiseLike<DbResult<T>> {
  private mode: Mode = 'select'
  private columns = '*'
  private embeds: EmbedSpec[] = []
  private conditions: Condition[] = []
  private orderBy: string[] = []
  private limitN: number | null = null
  private offsetN: number | null = null
  private payload: Record<string, unknown>[] = []
  private conflictTarget: string | null = null
  private wantCount = false
  private headOnly = false
  private returning = false
  private singleMode: 'one' | 'maybe' | null = null

  constructor(
    private table: string,
    private opts: BuilderOptions = {}
  ) {
    assertTable(table)
  }

  // ── Mode ───────────────────────────────────────────────────────────────────

  select(columns = '*', options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    if (this.mode === 'select') {
      this.parseSelect(columns)
    } else {
      // .insert(...).select('id') -- a RETURNING clause, not a new query.
      this.returning = true
      this.parseSelect(columns)
    }

    if (options?.count) this.wantCount = true
    if (options?.head) {
      this.headOnly = true
      this.wantCount = true
    }
    return this
  }

  insert(rows: Record<string, unknown> | Record<string, unknown>[]): this {
    this.mode = 'insert'
    this.payload = Array.isArray(rows) ? rows : [rows]
    return this
  }

  update(values: Record<string, unknown>): this {
    this.mode = 'update'
    this.payload = [values]
    return this
  }

  upsert(
    rows: Record<string, unknown> | Record<string, unknown>[],
    options?: { onConflict?: string }
  ): this {
    this.mode = 'upsert'
    this.payload = Array.isArray(rows) ? rows : [rows]
    this.conflictTarget = options?.onConflict ?? null
    return this
  }

  delete(): this {
    this.mode = 'delete'
    return this
  }

  // ── Filters ────────────────────────────────────────────────────────────────

  eq(column: string, value: unknown): this { return this.cmp(column, '=', value) }
  neq(column: string, value: unknown): this { return this.cmp(column, '<>', value) }
  gt(column: string, value: unknown): this { return this.cmp(column, '>', value) }
  gte(column: string, value: unknown): this { return this.cmp(column, '>=', value) }
  lt(column: string, value: unknown): this { return this.cmp(column, '<', value) }
  lte(column: string, value: unknown): this { return this.cmp(column, '<=', value) }
  like(column: string, pattern: string): this { return this.cmp(column, 'LIKE', pattern) }
  ilike(column: string, pattern: string): this { return this.cmp(column, 'ILIKE', pattern) }

  // `= ANY($n)` rather than `IN (...)` deliberately: an empty array is a SQL
  // SYNTAX ERROR with IN, and simply matches nothing with ANY. 62 call sites
  // pass a list that can legitimately be empty -- "the buckets this client is
  // in", say -- and every one of them expects no rows, not a 500.
  in(column: string, values: unknown[]): this {
    assertColumn(this.table, column)
    this.conditions.push({
      sql: `${quoteIdent(column)} = ANY(?)`,
      values: [values ?? []],
    })
    return this
  }

  is(column: string, value: null | boolean): this {
    assertColumn(this.table, column)
    const literal = value === null ? 'NULL' : value ? 'TRUE' : 'FALSE'
    this.conditions.push({ sql: `${quoteIdent(column)} IS ${literal}`, values: [] })
    return this
  }

  not(column: string, operator: string, value: unknown): this {
    assertColumn(this.table, column)
    if (operator === 'is') {
      const literal = value === null ? 'NULL' : value ? 'TRUE' : 'FALSE'
      this.conditions.push({ sql: `${quoteIdent(column)} IS NOT ${literal}`, values: [] })
      return this
    }
    this.conditions.push({ sql: `NOT (${quoteIdent(column)} ${sqlOperator(operator)} ?)`, values: [value] })
    return this
  }

  contains(column: string, value: unknown): this {
    assertColumn(this.table, column)
    this.conditions.push({ sql: `${quoteIdent(column)} @> ?`, values: [value] })
    return this
  }

  // `.match({ a: 1, b: 2 })` -- shorthand for chained eq.
  match(query: Record<string, unknown>): this {
    for (const [column, value] of Object.entries(query)) this.eq(column, value)
    return this
  }

  // PostgREST's raw filter form: .filter('col', 'eq', value).
  filter(column: string, operator: string, value: unknown): this {
    return this.cmp(column, sqlOperator(operator), value)
  }

  // ── .or() ──────────────────────────────────────────────────────────────────
  // Receives a PostgREST filter string: "name.ilike.%x%,code.ilike.%x%".
  // Nearly every call site generates it through ilikeAcross() in
  // app/lib/pagination.ts, so the vocabulary in practice is eq and ilike.
  //
  // Grouped in its own parentheses. Flattening these into the AND chain would
  // silently widen every search -- one clause ORed against the tenancy filter
  // would return other tenants' rows.
  or(filters: string): this {
    const parts = filters.split(',').map(s => s.trim()).filter(Boolean)
    const clauses: string[] = []
    const values: unknown[] = []

    for (const part of parts) {
      // column.operator.value -- the value may itself contain dots, so split
      // only on the first two.
      const first = part.indexOf('.')
      const second = part.indexOf('.', first + 1)
      if (first === -1 || second === -1) {
        throw new Error(`[db] cannot parse .or() clause: ${JSON.stringify(part)}`)
      }

      const column = part.slice(0, first)
      const operator = part.slice(first + 1, second)
      const value = part.slice(second + 1)

      assertColumn(this.table, column)
      clauses.push(`${quoteIdent(column)} ${sqlOperator(operator)} ?`)
      values.push(value)
    }

    if (clauses.length > 0) {
      this.conditions.push({ sql: `(${clauses.join(' OR ')})`, values })
    }
    return this
  }

  // ── Modifiers ──────────────────────────────────────────────────────────────

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    assertColumn(this.table, column)
    const dir = options?.ascending === false ? 'DESC' : 'ASC'
    const nulls = options?.nullsFirst === true ? ' NULLS FIRST'
      : options?.nullsFirst === false ? ' NULLS LAST' : ''
    this.orderBy.push(`${quoteIdent(column)} ${dir}${nulls}`)
    return this
  }

  limit(n: number): this {
    this.limitN = n
    return this
  }

  // Inclusive at BOTH ends, matching PostgREST: .range(0, 9) is ten rows.
  range(from: number, to: number): this {
    this.offsetN = from
    this.limitN = to - from + 1
    return this
  }

  // ── Terminals ──────────────────────────────────────────────────────────────

  // Both narrow the result type from "array of rows" to "one row", mirroring
  // supabase-js. Without this, `data` still types as an array after
  // .maybeSingle() and every call site has to cast -- which defeats the point
  // of the swap being invisible.
  maybeSingle(): QueryBuilder<ElementOf<T> | null> {
    this.singleMode = 'maybe'
    return this as unknown as QueryBuilder<ElementOf<T> | null>
  }

  single(): QueryBuilder<ElementOf<T>> {
    this.singleMode = 'one'
    return this as unknown as QueryBuilder<ElementOf<T>>
  }

  // Declares an embedded relation the shim cannot infer. Used by the handful of
  // call sites that rely on PostgREST's foreign-key embedding.
  withEmbed(spec: EmbedSpec): this {
    assertTable(spec.table)
    this.embeds.push(spec)
    return this
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private async execute(): Promise<DbResult<T>> {
    try {
      const { sql, values } = this.build()
      this.opts.onQuery?.({ table: this.table, sql, values })

      let count: number | null = null
      if (this.wantCount) count = await this.runCount()

      if (this.headOnly) {
        return ok(null as unknown as T, count)
      }

      const rows = await this.run(sql, values)
      const shaped = this.embeds.length > 0 ? this.shapeEmbeds(rows) : rows

      if (this.singleMode) {
        if (shaped.length === 1) return ok(shaped[0] as unknown as T, count)
        if (shaped.length === 0 && this.singleMode === 'maybe') {
          return ok(null as unknown as T, count)
        }
        return fail(notASingleRow(shaped.length))
      }

      // A write with no .select() returns null data, as PostgREST does.
      if (this.mode !== 'select' && !this.returning) {
        return ok(null as unknown as T, count)
      }

      return ok(shaped as unknown as T, count)
    } catch (err) {
      // NEVER throws. Every call site is written against { data, error }.
      return fail(toDbError(err))
    }
  }

  private async run(sql: string, values: unknown[]): Promise<Record<string, unknown>[]> {
    const client = this.opts.client
    if (client) {
      const res = await client.query(sql, values)
      return res.rows
    }
    const p: Pool = getPool()
    const res = await p.query(sql, values)
    return res.rows
  }

  private async runCount(): Promise<number> {
    const where = this.whereClause(1)
    const sql =
      `SELECT count(*)::int AS n FROM ${quoteIdent(this.table)}${where.sql}`
    const rows = await this.run(sql, where.values)
    return Number(rows[0]?.n ?? 0)
  }

  // ── SQL assembly ───────────────────────────────────────────────────────────

  private build(): { sql: string; values: unknown[] } {
    switch (this.mode) {
      case 'select': return this.buildSelect()
      case 'insert': return this.buildInsert()
      case 'upsert': return this.buildInsert(true)
      case 'update': return this.buildUpdate()
      case 'delete': return this.buildDelete()
    }
  }

  private buildSelect(): { sql: string; values: unknown[] } {
    const t = quoteIdent(this.table)
    const cols = this.selectList('base')
    const joins = this.embeds.map((e, i) => {
      const alias = `e${i}`
      const kind = e.inner ? 'INNER' : 'LEFT'
      return ` ${kind} JOIN ${quoteIdent(e.table)} ${alias} ` +
        `ON ${alias}.${quoteIdent(e.foreignColumn)} = base.${quoteIdent(e.localColumn)}`
    }).join('')

    const where = this.whereClause(1, 'base')
    const order = this.orderBy.length > 0
      ? ` ORDER BY ${this.orderBy.map(o => `base.${o}`).join(', ')}`
      : ''

    let sql = `SELECT ${cols} FROM ${t} base${joins}${where.sql}${order}`
    const values = [...where.values]

    if (this.limitN !== null) { values.push(this.limitN); sql += ` LIMIT $${values.length}` }
    if (this.offsetN !== null) { values.push(this.offsetN); sql += ` OFFSET $${values.length}` }

    return { sql, values }
  }

  private buildInsert(upsert = false): { sql: string; values: unknown[] } {
    if (this.payload.length === 0) {
      throw new Error(`[db] insert into "${this.table}" with no rows`)
    }

    // The union of keys across all rows, so a batch whose rows differ still
    // produces one well-formed statement with NULLs where a key is absent.
    const columns = [...new Set(this.payload.flatMap(r => Object.keys(r)))]
    columns.forEach(c => assertColumn(this.table, c))

    const values: unknown[] = []
    const tuples = this.payload.map(row => {
      const placeholders = columns.map(c => {
        values.push(row[c] ?? null)
        return `$${values.length}`
      })
      return `(${placeholders.join(', ')})`
    })

    let sql =
      `INSERT INTO ${quoteIdent(this.table)} (${columns.map(quoteIdent).join(', ')}) ` +
      `VALUES ${tuples.join(', ')}`

    if (upsert) {
      const target = (this.conflictTarget ?? '')
        .split(',').map(s => s.trim()).filter(Boolean)
      target.forEach(c => assertColumn(this.table, c))

      if (target.length === 0) {
        sql += ' ON CONFLICT DO NOTHING'
      } else {
        const updates = columns
          .filter(c => !target.includes(c))
          .map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        sql += ` ON CONFLICT (${target.map(quoteIdent).join(', ')}) ` +
          (updates.length > 0 ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING')
      }
    }

    if (this.returning) sql += ` RETURNING ${this.selectList('flat')}`
    return { sql, values }
  }

  private buildUpdate(): { sql: string; values: unknown[] } {
    const row = this.payload[0] ?? {}
    const columns = Object.keys(row)
    columns.forEach(c => assertColumn(this.table, c))

    const values: unknown[] = []
    const sets = columns.map(c => {
      values.push(row[c])
      return `${quoteIdent(c)} = $${values.length}`
    })

    const where = this.whereClause(values.length + 1)
    values.push(...where.values)

    let sql = `UPDATE ${quoteIdent(this.table)} SET ${sets.join(', ')}${where.sql}`
    if (this.returning) sql += ` RETURNING ${this.selectList('flat')}`
    return { sql, values }
  }

  private buildDelete(): { sql: string; values: unknown[] } {
    const where = this.whereClause(1)
    let sql = `DELETE FROM ${quoteIdent(this.table)}${where.sql}`
    if (this.returning) sql += ` RETURNING ${this.selectList('flat')}`
    return { sql, values: where.values }
  }

  // Placeholders are numbered at assembly time, not when the filter was added,
  // because UPDATE puts its SET values ahead of the WHERE values.
  private whereClause(startAt: number, prefix = ''): { sql: string; values: unknown[] } {
    if (this.conditions.length === 0) return { sql: '', values: [] }

    const values: unknown[] = []
    let n = startAt

    const parts = this.conditions.map(c => {
      let sql = c.sql
      for (const v of c.values) {
        values.push(v)
        sql = sql.replace('?', `$${n++}`)
      }
      return prefix ? sql.replace(/"(\w+)"/g, `${prefix}."$1"`) : sql
    })

    return { sql: ` WHERE ${parts.join(' AND ')}`, values }
  }

  private selectList(context: 'base' | 'flat'): string {
    const prefix = context === 'base' ? 'base.' : ''

    if (this.columns === '*') {
      const all = TABLE_COLUMNS[this.table].map(c => `${prefix}${quoteIdent(c)}`)
      return [...all, ...this.embedSelectList()].join(', ')
    }

    const own = this.columns
      .split(',')
      .map(c => c.trim())
      .filter(Boolean)
      .map(c => {
        assertColumn(this.table, c)
        return `${prefix}${quoteIdent(c)}`
      })

    return [...own, ...this.embedSelectList()].join(', ')
  }

  private embedSelectList(): string[] {
    return this.embeds.flatMap((e, i) =>
      e.columns.map(c => {
        assertColumn(e.table, c)
        // Flattened with a marker, then re-nested in shapeEmbeds. Simpler and
        // far easier to read in a log than a json_build_object per row.
        return `e${i}.${quoteIdent(c)} AS "${e.alias}__${c}"`
      })
    )
  }

  // PostgREST nests a to-one relation as an object; the call sites read it that
  // way, so the flat columns are folded back into one.
  private shapeEmbeds(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map(row => {
      const out: Record<string, unknown> = {}
      const nested: Record<string, Record<string, unknown>> = {}

      for (const [key, value] of Object.entries(row)) {
        const marker = key.indexOf('__')
        if (marker === -1) { out[key] = value; continue }

        const alias = key.slice(0, marker)
        const column = key.slice(marker + 2)
        nested[alias] ??= {}
        nested[alias][column] = value
      }

      for (const e of this.embeds) {
        const obj = nested[e.alias]
        // All-null means the LEFT JOIN matched nothing -- PostgREST reports
        // that as null, not as an object of nulls.
        const empty = !obj || Object.values(obj).every(v => v === null)
        out[e.alias] = empty ? null : obj
      }

      return out
    })
  }

  private parseSelect(columns: string): void {
    // Embeds are declared through withEmbed(), not parsed out of the string --
    // resolving `clients(id, name)` needs a foreign-key catalogue the shim does
    // not have. A select string containing one is refused loudly rather than
    // silently returning the wrong shape.
    if (/\w+\s*\(/.test(columns)) {
      throw new Error(
        `[db] select() on "${this.table}" contains an embedded relation:\n  ${columns}\n` +
        `The shim cannot infer PostgREST embeds. Declare it with .withEmbed({...}) instead.`
      )
    }
    this.columns = columns
  }

  private cmp(column: string, operator: string, value: unknown): this {
    assertColumn(this.table, column)
    if (value === null) {
      this.conditions.push({
        sql: `${quoteIdent(column)} IS ${operator === '<>' ? 'NOT ' : ''}NULL`,
        values: [],
      })
      return this
    }
    this.conditions.push({ sql: `${quoteIdent(column)} ${operator} ?`, values: [value] })
    return this
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sqlOperator(op: string): string {
  const map: Record<string, string> = {
    eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
    like: 'LIKE', ilike: 'ILIKE',
    '=': '=', '<>': '<>', '>': '>', '>=': '>=', '<': '<', '<=': '<=',
    LIKE: 'LIKE', ILIKE: 'ILIKE',
  }
  const sql = map[op]
  if (!sql) throw new Error(`[db] unsupported operator: ${JSON.stringify(op)}`)
  return sql
}

function ok<T>(data: T, count: number | null): DbResult<T> {
  return { data, error: null, count, status: 200, statusText: 'OK' }
}

function fail<T>(error: DbError): DbResult<T> {
  return { data: null as unknown as T, error, count: null, status: 400, statusText: 'Bad Request' }
}
