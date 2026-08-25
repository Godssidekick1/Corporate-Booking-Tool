import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/company-policy-groups?companyId=<uuid> ──────────────────
// Lists every policy group currently linked to a company, with its rank
// range, so a UI can show "this company uses PLCYGRP1 (ranks 1-3) and
// PLCYGRP2 (ranks 4-6)" and know which ranges are still uncovered.
//
// ── POST /api/tmc/company-policy-groups ───────────────────────────────────
// Links a policy group to a company. Rejects if the group's rank range
// would overlap any group already linked to that company — per explicit
// product direction, overlapping ranges are a configuration error to
// prevent at assignment time, not something resolveEffectivePolicy.ts
// should have to arbitrate at read time.
//
// ── DELETE /api/tmc/company-policy-groups?companyId=<uuid>&policyGroupId=<uuid> ──
// Unlinks a group from a company. Doesn't touch the group itself or any
// other company using it — this only removes the one link row.
// ─────────────────────────────────────────────────────────────────────────────

interface LinkBody {
  companyId: string
  policyGroupId: string
}

// Two ranges overlap unless one entirely ends before the other begins.
// NULL on either side of a range means "unbounded" in that direction, so an
// unbounded group overlaps everything that isn't itself impossible (a range
// with min > max, which shouldn't exist but isn't this function's job to
// validate).
function rangesOverlap(
  aMin: number | null, aMax: number | null,
  bMin: number | null, bMax: number | null
): boolean {
  const aMinVal = aMin ?? -Infinity
  const aMaxVal = aMax ?? Infinity
  const bMinVal = bMin ?? -Infinity
  const bMaxVal = bMax ?? Infinity
  return aMinVal <= bMaxVal && bMinVal <= aMaxVal
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
  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: links, error } = await service
    .from('company_policy_groups')
    .select('policy_group_id, assigned_at')
    .eq('company_id', companyId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const groupIds = (links ?? []).map(l => l.policy_group_id)
  if (groupIds.length === 0) {
    return Response.json({ ok: true, links: [] })
  }

  const { data: groups } = await service
    .from('policy_groups')
    .select('id, name, code, min_band_rank, max_band_rank')
    .in('id', groupIds)

  const groupById = new Map((groups ?? []).map(g => [g.id, g]))

  const enriched = (links ?? [])
    .map(l => ({
      policyGroupId: l.policy_group_id,
      assignedAt: l.assigned_at,
      group: groupById.get(l.policy_group_id) ?? null,
    }))
    .sort((a, b) => (a.group?.min_band_rank ?? -Infinity) - (b.group?.min_band_rank ?? -Infinity))

  return Response.json({ ok: true, links: enriched })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: LinkBody = await req.json()
  const { companyId, policyGroupId } = body

  if (!companyId || !policyGroupId) {
    return Response.json({ error: 'companyId and policyGroupId are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: newGroup } = await service
    .from('policy_groups')
    .select('id, name, tmc_id, min_band_rank, max_band_rank')
    .eq('id', policyGroupId)
    .maybeSingle()

  if (!newGroup) {
    return Response.json({ error: 'Policy group not found' }, { status: 404 })
  }

  if (auth.tmcId !== newGroup.tmc_id) {
    return Response.json({ error: 'This policy group belongs to a different TMC' }, { status: 403 })
  }

  // Confirm the company actually belongs to this TMC too — a crafted
  // companyId from another TMC's client shouldn't be linkable even if the
  // caller passes the manage_policy check generically.
  const { data: company } = await service
    .from('companies')
    .select('id, tmc_id')
    .eq('id', companyId)
    .maybeSingle()

  if (!company || company.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Company not found for this TMC' }, { status: 404 })
  }

  const { data: existingLinks } = await service
    .from('company_policy_groups')
    .select('policy_group_id')
    .eq('company_id', companyId)

  const existingGroupIds = (existingLinks ?? []).map(l => l.policy_group_id)

  if (existingGroupIds.includes(policyGroupId)) {
    return Response.json({ error: `"${newGroup.name}" is already linked to this company` }, { status: 409 })
  }

  if (existingGroupIds.length > 0) {
    const { data: existingGroups } = await service
      .from('policy_groups')
      .select('id, name, min_band_rank, max_band_rank')
      .in('id', existingGroupIds)

    const overlapping = (existingGroups ?? []).find(g =>
      rangesOverlap(newGroup.min_band_rank, newGroup.max_band_rank, g.min_band_rank, g.max_band_rank)
    )

    if (overlapping) {
      return Response.json({
        error: `"${newGroup.name}" overlaps with "${overlapping.name}", which is already linked to this company. Each linked group must cover a distinct rank range.`,
      }, { status: 409 })
    }
  }

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  const { error: insertError } = await service
    .from('company_policy_groups')
    .insert({
      company_id: companyId,
      policy_group_id: policyGroupId,
      assigned_by: caller?.id ?? null,
    })

  if (insertError) {
    // 23P01 is raised by the company_policy_groups_no_overlap constraint
    // trigger. The check above catches this in the ordinary case; the trigger
    // is the backstop for two links racing each other, where both requests
    // read the pre-insert state and neither sees the other's pending row.
    if (insertError.code === '23P01') {
      return Response.json({ error: insertError.message }, { status: 409 })
    }
    return Response.json({ error: insertError.message }, { status: 500 })
  }

  return Response.json({ ok: true }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  const policyGroupId = req.nextUrl.searchParams.get('policyGroupId')

  if (!companyId || !policyGroupId) {
    return Response.json({ error: 'companyId and policyGroupId are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { error } = await service
    .from('company_policy_groups')
    .delete()
    .eq('company_id', companyId)
    .eq('policy_group_id', policyGroupId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}