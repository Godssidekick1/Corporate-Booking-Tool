import { sql, many, one, exec, json, empty, type Queryable, type Sql } from '@/app/lib/db/sql'
import { searchAcross, page } from '@/app/lib/db/fragments'
import type { PageParams } from '@/app/lib/pagination'

// ── coverage_state, deal_code_coverage, commercial_coverage ──────────────────
// The stored coverage reports. What goes in them is decided by the resolvers
// (app/lib/coverage); this module only stores, checks and reads them.
// Invalidation is not here at all: triggers on the source tables bump
// coverage_state (20261010000000_coverage_tables.sql).
// ─────────────────────────────────────────────────────────────────────────────

export type Report = 'deal_codes' | 'commercials'

export interface Freshness {
  // Writes so far to the tables this report is computed from.
  changes: number
  // The `changes` value, and the date, the stored rows were computed from.
  builtFrom: number | null
  builtOn: string | null
}

export async function freshness(db: Queryable, tmcId: string, report: Report): Promise<Freshness> {
  const cols = report === 'deal_codes'
    ? sql`deal_codes_changes as changes, deal_codes_built_from as "builtFrom", deal_codes_built_on as "builtOn"`
    : sql`commercials_changes as changes, commercials_built_from as "builtFrom", commercials_built_on as "builtOn"`
  // The row is created on first use, so a TMC no write has touched yet still
  // has a counter to build against.
  await exec(db, sql`insert into coverage_state (tmc_id) values (${tmcId}) on conflict (tmc_id) do nothing`)
  return one<Freshness>(db, sql`select ${cols} from coverage_state where tmc_id = ${tmcId}`)
}

// One builder per TMC and report at a time; a second request waits here and
// then finds the rows fresh. Released at the end of the transaction.
export async function lockBuild(db: Queryable, tmcId: string, report: Report): Promise<void> {
  await one(db, sql`select pg_advisory_xact_lock(hashtext(${'coverage:' + report}), hashtext(${tmcId}))`)
}

async function markBuilt(db: Queryable, tmcId: string, report: Report, from: number, on: string): Promise<void> {
  await exec(db, report === 'deal_codes'
    ? sql`update coverage_state set deal_codes_built_from = ${from}, deal_codes_built_on = ${on} where tmc_id = ${tmcId}`
    : sql`update coverage_state set commercials_built_from = ${from}, commercials_built_on = ${on} where tmc_id = ${tmcId}`)
}

// Rows go in as JSON, a few thousand at a time: one parameter per chunk rather
// than one per value, and well under any statement size limit.
const CHUNK = 5_000

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK))
  return out
}

// ═══ deal_code_coverage ═════════════════════════════════════════════════════

export interface DealCoverageRow {
  clientId: string
  clientName: string
  airline: string
  codeType: string
  code: string
  via: string
  ambiguous: boolean
  // The closest losers, most-nearly-won first, and how many others lost.
  beat: { code: string; via: string }[]
  beatMore: number
}

// Replaces the TMC's stored report with `rows`, in the order given, and records
// what it was built from. Last, so the coverage_state row is locked only for
// the end of the transaction and writers bumping it barely wait.
export async function replaceDealCoverage(
  db: Queryable, tmcId: string, rows: readonly DealCoverageRow[], from: number, on: string
): Promise<void> {
  await exec(db, sql`delete from deal_code_coverage where tmc_id = ${tmcId}`)
  let ord = 0
  for (const chunk of chunks(rows)) {
    const numbered = chunk.map(r => ({ ...r, ord: ord++ }))
    await exec(db, sql`
      insert into deal_code_coverage
        (tmc_id, client_id, ord, client_name, airline, code_type, code, via, ambiguous, beat, beat_more)
      select ${tmcId}, r."clientId", r.ord, r."clientName", r.airline, r."codeType", r.code, r.via, r.ambiguous, r.beat, r."beatMore"
      from jsonb_to_recordset(${json(numbered)}) as r(
        "clientId" uuid, ord integer, "clientName" text, airline text, "codeType" text,
        code text, via text, ambiguous boolean, beat jsonb, "beatMore" integer)`)
  }
  await markBuilt(db, tmcId, 'deal_codes', from, on)
}

export interface CoverageScope {
  // null = every client of the TMC; otherwise only these (a counsellor's).
  accessibleIds: readonly string[] | null
  clientId?: string | null
}

function scoped(tmcId: string, scope: CoverageScope): Sql {
  return sql`tmc_id = ${tmcId}
    ${scope.accessibleIds !== null ? sql`and client_id = any(${[...scope.accessibleIds]})` : empty}
    ${scope.clientId ? sql`and client_id = ${scope.clientId}` : empty}`
}

export async function dealCoveragePage(
  db: Queryable, tmcId: string, scope: CoverageScope, params: PageParams
): Promise<{ items: DealCoverageRow[]; total: number }> {
  // Matched against the client, the code, the airline and the route it
  // arrived by -- which is how searching a bucket or group name finds
  // everything it hands out ("Bucket · Star Alliance FY26").
  const where = sql`${scoped(tmcId, scope)}
    ${searchAcross([sql`client_name`, sql`code`, sql`via`, sql`airline`], params.search)}`
  const [items, count] = await Promise.all([
    many<DealCoverageRow>(db, sql`
      select client_id as "clientId", client_name as "clientName", airline, code_type as "codeType",
             code, via, ambiguous, beat, beat_more as "beatMore"
      from deal_code_coverage where ${where}
      order by ord ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from deal_code_coverage where ${where}`),
  ])
  return { items, total: count.n }
}

// ═══ commercial_coverage ════════════════════════════════════════════════════

export type CoverageKind = 'markup' | 'discount' | 'processing_fee'

export interface CommercialCoverageRow {
  clientId: string
  clientName: string
  markup: string | null
  markupVia: string | null
  discount: string | null
  discountVia: string | null
  fee: string | null
  feeVia: string | null
  netPercent: number | null
  lossMaking: boolean
  ambiguous: boolean
  variesByCategory: CoverageKind[]
  switchedOff: CoverageKind[]
}

export async function replaceCommercialCoverage(
  db: Queryable, tmcId: string, rows: readonly CommercialCoverageRow[], from: number, on: string
): Promise<void> {
  await exec(db, sql`delete from commercial_coverage where tmc_id = ${tmcId}`)
  let ord = 0
  for (const chunk of chunks(rows)) {
    const numbered = chunk.map(r => ({ ...r, ord: ord++ }))
    await exec(db, sql`
      insert into commercial_coverage
        (tmc_id, client_id, ord, client_name, markup, markup_via, discount, discount_via, fee, fee_via,
         net_percent, loss_making, ambiguous, varies_by_category, switched_off)
      select ${tmcId}, r."clientId", r.ord, r."clientName", r.markup, r."markupVia", r.discount, r."discountVia",
             r.fee, r."feeVia", r."netPercent", r."lossMaking", r.ambiguous,
             array(select jsonb_array_elements_text(r."variesByCategory")),
             array(select jsonb_array_elements_text(r."switchedOff"))
      from jsonb_to_recordset(${json(numbered)}) as r(
        "clientId" uuid, ord integer, "clientName" text, markup text, "markupVia" text,
        discount text, "discountVia" text, fee text, "feeVia" text, "netPercent" numeric,
        "lossMaking" boolean, ambiguous boolean, "variesByCategory" jsonb, "switchedOff" jsonb)`)
  }
  await markBuilt(db, tmcId, 'commercials', from, on)
}

export async function commercialCoveragePage(
  db: Queryable, tmcId: string, scope: CoverageScope, kind: CoverageKind | null, params: PageParams
): Promise<{ items: CommercialCoverageRow[]; total: number; lossMakingCount: number }> {
  const has = kind === 'markup' ? sql`and markup is not null`
    : kind === 'discount' ? sql`and discount is not null`
    : kind === 'processing_fee' ? sql`and fee is not null`
    : empty
  const where = sql`${scoped(tmcId, scope)} ${has}
    ${searchAcross([sql`client_name`, sql`markup`, sql`discount`, sql`fee`,
      sql`markup_via`, sql`discount_via`, sql`fee_via`], params.search)}`
  const [items, count, losing] = await Promise.all([
    many<CommercialCoverageRow>(db, sql`
      select client_id as "clientId", client_name as "clientName", markup, markup_via as "markupVia",
             discount, discount_via as "discountVia", fee, fee_via as "feeVia",
             net_percent as "netPercent", loss_making as "lossMaking", ambiguous,
             varies_by_category as "variesByCategory", switched_off as "switchedOff"
      from commercial_coverage where ${where}
      order by ord ${page(params)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from commercial_coverage where ${where}`),
    // Across every client in scope, whatever the search or kind filter, so the
    // screen can warn without reading every page.
    one<{ n: number }>(db, sql`
      select count(*)::int as n from commercial_coverage where ${scoped(tmcId, scope)} and loss_making`),
  ])
  return { items, total: count.n, lossMakingCount: losing.n }
}
