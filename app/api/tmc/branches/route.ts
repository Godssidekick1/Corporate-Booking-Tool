import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/branches ─────────────────────────────────────────────────────
// List all branches for this TMC. Any TMC-side caller can view.
//
// ── POST /api/tmc/branches ────────────────────────────────────────────────────
// Create a new branch. Requires manage_branches permission (or tmc_admin).
// ─────────────────────────────────────────────────────────────────────────────

interface CreateBranchBody {
  name: string
  city?: string
  country?: string
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: caller } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (!caller || !caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: branches, error } = await service
    .from('branches')
    .select('id, name, city, country, created_at')
    .eq('tmc_id', caller.tmc_id)
    .order('name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, branches: branches ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const auth = await requireTmcPermission(service, user.id, 'manage_branches')
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const body: CreateBranchBody = await req.json()
  const { name, city, country } = body

  if (!name?.trim()) {
    return Response.json({ error: 'Branch name is required' }, { status: 400 })
  }

  const { data: branch, error } = await service
    .from('branches')
    .insert({
      tmc_id: auth.tmcId,
      name: name.trim(),
      city: city?.trim() || null,
      country: country?.trim() || null,
    })
    .select('id, name, city, country, created_at')
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, branch }, { status: 201 })
}