import type { Queryable } from '@/app/lib/db'
import type { Scope } from '@/app/lib/repositories/reports'
import type { Report, ReportFilters, FilterKey } from './types'
import { CORPORATE_CATALOG, TMC_CATALOG } from './catalog'
import * as corporate from './corporate'
import * as tmc from './tmc'

// ── Each report's builder, by key ────────────────────────────────────────────
// The list, titles and filters are the catalog's (shared with the screens);
// this attaches what builds each one. The routes look a report up here.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportDef<S extends Scope = Scope> {
  key: string
  title: string
  filters: readonly FilterKey[]
  build: (db: Queryable, scope: S, f: ReportFilters) => Promise<Report>
}

type ClientScope = Extract<Scope, { side: 'client' }>
type TmcScope = Extract<Scope, { side: 'tmc' }>
type Builders<C extends readonly { key: string }[], S extends Scope> = Record<C[number]['key'], ReportDef<S>['build']>

const CORPORATE_BUILDERS: Builders<typeof CORPORATE_CATALOG, ClientScope> = {
  spend: corporate.spend,
  compliance: corporate.compliance,
  savings: corporate.savings,
  approvals: corporate.approvals,
  trips: corporate.trips,
  patterns: corporate.patterns,
}

const TMC_BUILDERS: Builders<typeof TMC_CATALOG, TmcScope> = {
  revenue: tmc.revenue,
  activity: tmc.activity,
  airlines: tmc.airlines,
  desk: tmc.desk,
  compliance: tmc.compliance,
  payments: tmc.payments,
}

export const CORPORATE_REPORTS: readonly ReportDef<ClientScope>[] =
  CORPORATE_CATALOG.map(c => ({ ...c, build: CORPORATE_BUILDERS[c.key] }))

export const TMC_REPORTS: readonly ReportDef<TmcScope>[] =
  TMC_CATALOG.map(c => ({ ...c, build: TMC_BUILDERS[c.key] }))
