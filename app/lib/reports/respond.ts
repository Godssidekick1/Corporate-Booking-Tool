import { db } from '@/app/lib/db'
import { rateLimited } from '@/app/lib/http/rateLimit'
import type { Scope } from '@/app/lib/repositories/reports'
import type { ReportDef } from './registry'
import { parseFilters } from './filters'
import { csvResponse } from './csv'

// ── Answering a report request, either side ──────────────────────────────────
// The routes settle who is asking and what they may see (the scope); this
// reads the filters, builds the report and answers with it as JSON, or with
// one of its tables as CSV (?format=csv&table=<key>, the first by default).
// ─────────────────────────────────────────────────────────────────────────────

export async function respond<S extends Scope>(
  defs: readonly ReportDef<S>[],
  key: string,
  scope: S,
  params: URLSearchParams,
  userId: string,
): Promise<Response> {
  const def = defs.find(d => d.key === key)
  if (!def) return Response.json({ error: 'No such report' }, { status: 404 })

  const parsed = parseFilters(params, def.filters)
  if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 })

  const csv = params.get('format') === 'csv'
  if (csv) {
    const limited = await rateLimited('csv', userId)
    if (limited) return limited
  }

  const report = await def.build(db, scope, parsed.filters)
  if (!csv) return Response.json({ ok: true, filters: parsed.filters, report })

  const wanted = params.get('table')
  const table = wanted ? report.tables.find(t => t.key === wanted) : report.tables[0]
  if (!table) return Response.json({ error: 'No such table in this report' }, { status: 404 })
  const { from, to } = parsed.filters
  return csvResponse(table, `${report.title}-${table.title}-${from}-to-${to}`)
}
