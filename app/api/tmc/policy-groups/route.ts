import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/policy-groups?companyId=<uuid> ──────────────────────────────
// List policy groups for one company.
//
// ── POST /api/tmc/policy-groups ──────────────────────────────────────────────
// Create a new policy group for a company. Requires manage_policy permission
// and (for TCs) explicit access to that company.
// ─────────────────────────────────────────────────────────────────────────────

interface CreateGroupBody {
  companyId: string
  name: string
  description?: string
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const companyId = req.nextUrl.searchParams.get('companyId')

  if (!companyId) {
    return Response.json({ error: 'companyId is required' }, { status: 400 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: groups, error } = await service
    .from('policy_groups')
    .select('id, name, description, created_at')
    .eq('company_id', companyId)
    .order('name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Employee count per group, so the UI can show "12 employees" without a
  // second round-trip per group.
  const groupIds = (groups ?? []).map(g => g.id)
  let countsByGroup = new Map<string, number>()
  if (groupIds.length > 0) {
    const { data: memberships } = await service
      .from('employee_policy_groups')
      .select('policy_group_id')
      .in('policy_group_id', groupIds)
    for (const m of memberships ?? []) {
      countsByGroup.set(m.policy_group_id, (countsByGroup.get(m.policy_group_id) ?? 0) + 1)
    }
  }

  const enriched = (groups ?? []).map(g => ({
    ...g,
    employeeCount: countsByGroup.get(g.id) ?? 0,
  }))

  return Response.json({ ok: true, groups: enriched })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const body: CreateGroupBody = await req.json()
  const { companyId, name, description } = body

  if (!companyId || !name?.trim()) {
    return Response.json({ error: 'companyId and name are required' }, { status: 400 })
  }

  const auth = await requireTmcPermission(service, user.id, 'manage_policy', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: group, error } = await service
    .from('policy_groups')
    .insert({ company_id: companyId, name: name.trim(), description: description?.trim() || null })
    .select('id, name, description, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json({ error: `A policy group named "${name}" already exists for this company` }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, group: { ...group, employeeCount: 0 } }, { status: 201 })
}