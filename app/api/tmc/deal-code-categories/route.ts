import { createClient } from '@/utils/supabase/server'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { db, transaction } from '@/app/lib/db'

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

export const GET = route(async () => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  let categories = await dealCodes.categories(db, tmcId)

  // Seed on first read for a TMC created after the migration ran. One
  // transaction, and idempotent: two first reads racing each other both
  // succeed and seed once, where the old path could insert the set twice.
  if (categories.length === 0) {
    await transaction(tx => dealCodes.seedCategories(tx, tmcId, DEFAULT_CATEGORIES.map(c => ({
      code: c.code, label: c.label, types: DEFAULT_MATRIX[c.code] ?? {},
    }))), { tenantId: tmcId, userId: user.id })
    categories = await dealCodes.categories(db, tmcId)
  }

  const allowedByCategory = await dealCodes.allowedTypes(db, categories.map(c => c.id))

  return Response.json({
    ok: true,
    categories: categories.map(c => ({
      ...c,
      allowedTypes: allowedByCategory.get(c.id) ?? [],
    })),
  })
})
