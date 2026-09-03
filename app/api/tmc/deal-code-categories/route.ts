import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'

// ── GET /api/tmc/deal-code-categories ────────────────────────────────────────
// The TMC's airline categories, each with the code types it permits.
//
// Categories are a 2x2 of geography (DOM/INT) and settlement (BSP/LCC), and
// settlement is the half that carries behaviour: BSP content settles through
// the GDS and has a tour-code field, LCC direct-connect largely does not. The
// editor uses `allowedTypes` to disable the types a category cannot express,
// rather than letting someone file a tour code against an LCC deal that has
// nowhere to put it.
//
// Held as rows rather than an enum so a TMC can correct the matrix without a
// migration — the same "configurable per TMC" rule as bands and cost centres.
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors the seed in 20260905000000_deal_code_master.sql. Duplicated here on
// purpose: the migration seeds TMCs that existed when it ran, and this covers
// every TMC created afterwards. A trigger would hide the behaviour from anyone
// reading the signup path, and this route has to handle the empty case anyway.
const DEFAULT_CATEGORIES = [
  { code: 'DOMAIRBSP', label: 'Domestic - BSP settled' },
  { code: 'DOMAIRLCC', label: 'Domestic - LCC direct connect' },
  { code: 'INTAIRBSP', label: 'International - BSP settled' },
  { code: 'INTAIRLCC', label: 'International - LCC direct connect' },
] as const

const DEFAULT_MATRIX: Record<string, Record<string, boolean>> = {
  DOMAIRBSP: { TC: true,  PF: true,  DC: true, TR: true, PC: true },
  INTAIRBSP: { TC: true,  PF: true,  DC: true, TR: true, PC: true },
  DOMAIRLCC: { TC: false, PF: false, DC: true, TR: true, PC: true },
  INTAIRLCC: { TC: false, PF: false, DC: true, TR: true, PC: true },
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

  let { data: categories } = await service
    .from('deal_code_categories')
    .select('id, code, label, active')
    .eq('tmc_id', auth.tmcId)
    .order('code')

  // Seed on first read for a TMC created after the migration ran.
  if (!categories || categories.length === 0) {
    await service.from('deal_code_categories').insert(
      DEFAULT_CATEGORIES.map(c => ({ tmc_id: auth.tmcId, code: c.code, label: c.label }))
    )

    const { data: seeded } = await service
      .from('deal_code_categories')
      .select('id, code, label, active')
      .eq('tmc_id', auth.tmcId)
      .order('code')

    categories = seeded ?? []

    const matrixRows = categories.flatMap(cat =>
      Object.entries(DEFAULT_MATRIX[cat.code] ?? {}).map(([code_type, allowed]) => ({
        category_id: cat.id,
        code_type,
        allowed,
      }))
    )

    if (matrixRows.length > 0) {
      await service.from('deal_code_category_types').insert(matrixRows)
    }
  }

  const categoryIds = categories.map(c => c.id)

  const { data: matrix } = categoryIds.length
    ? await service
        .from('deal_code_category_types')
        .select('category_id, code_type, allowed')
        .in('category_id', categoryIds)
    : { data: [] }

  const allowedByCategory = new Map<string, string[]>()
  for (const row of matrix ?? []) {
    if (!row.allowed) continue
    const list = allowedByCategory.get(row.category_id)
    if (list) list.push(row.code_type)
    else allowedByCategory.set(row.category_id, [row.code_type])
  }

  return Response.json({
    ok: true,
    categories: categories.map(c => ({
      ...c,
      allowedTypes: allowedByCategory.get(c.id) ?? [],
    })),
  })
}
