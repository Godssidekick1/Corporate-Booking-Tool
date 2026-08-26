import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/bands?companyId=<uuid> ──────────────────────────────────────
// A company's bands, ordered by rank, with a count of employees on each so an
// admin can see what a rename or delete would touch.
//
// ── POST /api/tmc/bands ──────────────────────────────────────────────────────
// Adds a band. Codes and labels are entirely the client's own vocabulary —
// "L1", "A1", "C", "Band 3" are all fine. Only `rank` is structural: it is the
// company-agnostic integer that policy groups match on, so the same shared
// template applies positionally no matter what a company calls its bands.
//
// Bands used to be hardcoded L1..L5 at company creation with no way to change
// them, which is why the policy model looked more tightly coupled than it is.
// ─────────────────────────────────────────────────────────────────────────────

interface CreateBandBody {
  companyId: string
  code: string
  label: string
  rank: number
}

// Shared by both handlers here and by the [id] route.
export async function authoriseBandAccess(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  companyId: string
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(service, userId, 'manage_policy', companyId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  // tmc_admin passes the permission check for any companyId, so the tenancy
  // boundary is checked explicitly here.
  const { data: company } = await service
    .from('companies')
    .select('id, tmc_id')
    .eq('id', companyId)
    .maybeSingle()

  if (!company || company.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Company not found for this TMC', status: 404 }
  }

  return { ok: true }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  if (!companyId) {
    return Response.json({ error: 'companyId is required' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authoriseBandAccess(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const { data: bands, error } = await service
    .from('bands')
    .select('id, code, label, rank')
    .eq('company_id', companyId)
    .order('rank')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Employee count per band — a rename cascades automatically (see the
  // bands_sync_employees trigger), but a delete is blocked while anyone is on
  // the band, so the count is what tells an admin why.
  const { data: employees } = await service
    .from('employees')
    .select('band_code')
    .eq('company_id', companyId)

  const countByCode = new Map<string, number>()
  for (const e of employees ?? []) {
    if (!e.band_code) continue
    countByCode.set(e.band_code, (countByCode.get(e.band_code) ?? 0) + 1)
  }

  return Response.json({
    ok: true,
    bands: (bands ?? []).map(b => ({ ...b, employeeCount: countByCode.get(b.code) ?? 0 })),
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: CreateBandBody = await req.json()
  const { companyId, code, label, rank } = body

  if (!companyId || !code?.trim() || !label?.trim() || rank === undefined || rank === null) {
    return Response.json(
      { error: 'companyId, code, label, and rank are required' },
      { status: 400 }
    )
  }

  if (!Number.isInteger(Number(rank)) || Number(rank) < 0) {
    return Response.json({ error: 'rank must be a non-negative whole number' }, { status: 400 })
  }

  const service = createServiceClient()
  const access = await authoriseBandAccess(service, user.id, companyId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  // Two bands at the same rank would both match any policy group covering it,
  // which resolveEffectivePolicy can't arbitrate. The DB only enforces
  // uniqueness on (company_id, code), so rank is checked here.
  const { data: rankClash } = await service
    .from('bands')
    .select('code')
    .eq('company_id', companyId)
    .eq('rank', Number(rank))
    .maybeSingle()

  if (rankClash) {
    return Response.json(
      { error: `Rank ${rank} is already used by band "${rankClash.code}". Each band needs its own rank.` },
      { status: 409 }
    )
  }

  const { data: band, error } = await service
    .from('bands')
    .insert({
      company_id: companyId,
      code: code.trim(),
      label: label.trim(),
      rank: Number(rank),
    })
    .select('id, code, label, rank')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        { error: `This company already has a band with code "${code.trim()}"` },
        { status: 409 }
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, band: { ...band, employeeCount: 0 } }, { status: 201 })
}
