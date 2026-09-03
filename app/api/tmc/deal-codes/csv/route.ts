import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { validateFlightSpec } from '@/app/lib/deal-codes/flightSpec'
import { CODE_TYPES, CODE_TYPE_LABELS, type CodeType } from '../route'
import { NextRequest } from 'next/server'

// ── /api/tmc/deal-codes/csv ──────────────────────────────────────────────────
// GET   download every deal code as CSV
// POST  validate and apply an edited or newly authored file
//
// Airlines send deals as spreadsheets, and the screen being replaced makes you
// retype them one form at a time. Same convention as the traveller-profile
// importer: the DOWNLOAD IS THE TEMPLATE, columns matching exactly, so the
// workflow is export, edit, re-upload rather than filling a blank template and
// discovering the column names were wrong.
//
// POST is a two-phase call. `dryRun` returns the per-row verdicts that the
// preview step renders; without it the accepted rows are written and the
// rejected ones are skipped and reported. Nothing is partially applied by
// accident — the preview and the commit run exactly the same validation.
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS = [
  'code', 'code_type', 'airline_code', 'category', 'flight_spec',
  'sales_from', 'sales_to', 'travel_from', 'travel_to', 'active', 'notes',
] as const

// Lifted from traveler-profiles/csv — addresses and notes routinely contain
// commas, and a bare join would silently corrupt every row after the first one
// that has one.
function escapeCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const [{ data: deals }, { data: categories }] = await Promise.all([
    service
      .from('deal_codes')
      .select(
        'code, code_type, airline_code, category_id, flight_spec, sales_from, sales_to, travel_from, travel_to, active, notes'
      )
      .eq('tmc_id', auth.tmcId)
      .order('airline_code')
      .order('code'),
    service.from('deal_code_categories').select('id, code').eq('tmc_id', auth.tmcId),
  ])

  const categoryCode = new Map((categories ?? []).map(c => [c.id, c.code]))

  const rows = (deals ?? []).map(d =>
    COLUMNS.map(col => {
      if (col === 'category') return escapeCell(categoryCode.get(d.category_id))
      if (col === 'active') return escapeCell(d.active ? 'yes' : 'no')
      return escapeCell(d[col as keyof typeof d])
    }).join(',')
  )

  const csv = [COLUMNS.join(','), ...rows].join('\r\n')

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="deal-codes.csv"',
    },
  })
}

interface ImportRow {
  [key: string]: string | undefined
}

interface ImportBody {
  rows: ImportRow[]
  // Preview only. Same validation, nothing written.
  dryRun?: boolean
}

interface RowVerdict {
  row: number
  code: string
  valid: boolean
  error?: string
}

function parseDate(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  // Accepts what a spreadsheet exports; anything else is reported per-row
  // rather than silently becoming null, which would quietly widen a deal's
  // validity to "forever".
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : 'INVALID'
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const body: ImportBody = await req.json()

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return Response.json({ error: 'The file has no rows' }, { status: 400 })
  }
  if (body.rows.length > 1000) {
    return Response.json({ error: 'Maximum 1000 rows per upload' }, { status: 400 })
  }

  const { data: categories } = await service
    .from('deal_code_categories')
    .select('id, code')
    .eq('tmc_id', auth.tmcId)

  const categoryByCode = new Map((categories ?? []).map(c => [c.code.toUpperCase(), c.id]))
  const categoryIds = (categories ?? []).map(c => c.id)

  const { data: matrix } = categoryIds.length
    ? await service
        .from('deal_code_category_types')
        .select('category_id, code_type, allowed')
        .in('category_id', categoryIds)
    : { data: [] }

  const allowed = new Set(
    (matrix ?? []).filter(m => m.allowed).map(m => `${m.category_id}::${m.code_type}`)
  )

  const verdicts: RowVerdict[] = []
  const inserts: Record<string, unknown>[] = []

  for (const [i, row] of body.rows.entries()) {
    // +1 for the header, +1 because humans count from one.
    const rowNumber = i + 2
    const code = row.code?.trim().toUpperCase() ?? ''

    const fail = (error: string) => verdicts.push({ row: rowNumber, code, valid: false, error })

    if (!code) {
      fail('Missing code')
      continue
    }

    const airline = row.airline_code?.trim().toUpperCase() ?? ''
    if (!/^[A-Z0-9]{2}$/.test(airline)) {
      fail(`Unknown airline code '${row.airline_code?.trim() ?? ''}'`)
      continue
    }

    const codeType = row.code_type?.trim().toUpperCase() ?? ''
    if (!CODE_TYPES.includes(codeType as CodeType)) {
      fail(`Unknown code type '${codeType}'`)
      continue
    }

    const categoryCode = row.category?.trim().toUpperCase() ?? ''
    const categoryId = categoryByCode.get(categoryCode)
    if (!categoryId) {
      fail(`Unknown category '${categoryCode}'`)
      continue
    }

    if (!allowed.has(`${categoryId}::${codeType}`)) {
      fail(`${CODE_TYPE_LABELS[codeType as CodeType]} is not valid for ${categoryCode}`)
      continue
    }

    const flightSpec = row.flight_spec?.trim() || null
    const flightError = validateFlightSpec(flightSpec, airline)
    if (flightError) {
      fail(flightError)
      continue
    }

    const salesFrom = parseDate(row.sales_from)
    const salesTo = parseDate(row.sales_to)
    const travelFrom = parseDate(row.travel_from)
    const travelTo = parseDate(row.travel_to)

    if ([salesFrom, salesTo, travelFrom, travelTo].includes('INVALID')) {
      fail('Dates must be formatted YYYY-MM-DD')
      continue
    }

    if (salesFrom && salesTo && salesFrom > salesTo) {
      fail('Sales to is before sales from')
      continue
    }
    if (travelFrom && travelTo && travelFrom > travelTo) {
      fail('Travel to is before travel from')
      continue
    }

    verdicts.push({ row: rowNumber, code, valid: true })

    inserts.push({
      tmc_id: auth.tmcId,
      category_id: categoryId,
      airline_code: airline,
      code,
      code_type: codeType,
      flight_spec: flightSpec,
      sales_from: salesFrom,
      sales_to: salesTo,
      travel_from: travelFrom,
      travel_to: travelTo,
      // Anything other than an explicit no is active — a blank column in a
      // spreadsheet should not silently disable a deal someone just imported.
      active: (row.active?.trim().toLowerCase() ?? 'yes') !== 'no',
      notes: row.notes?.trim() || null,
      created_by: user.id,
    })
  }

  const accepted = verdicts.filter(v => v.valid).length
  const rejected = verdicts.length - accepted

  if (body.dryRun) {
    return Response.json({ ok: true, dryRun: true, accepted, rejected, verdicts })
  }

  if (inserts.length > 0) {
    const { error } = await service.from('deal_codes').insert(inserts)
    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }
  }

  return Response.json({ ok: true, imported: accepted, rejected, verdicts })
}
