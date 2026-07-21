import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/companies/[id] ─────────────────────────────────────────────
// Full detail view of one client company. tmc_admin sees any of their
// companies; a TC needs explicit access to this specific company.
//
// ── PATCH /api/tmc/companies/[id] ───────────────────────────────────────────
// tmc_admin only — company identity fields including booking_mode are a
// TMC-exclusive edit, not delegable to TCs via the permission system.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_CURRENCIES = ['INR'] as const
const ALLOWED_BOOKING_MODES = ['sbt', 'cbt', 'both'] as const

interface UpdateCompanyBody {
  name?: string
  timezone?: string
  currency?: string
  country?: string
  booking_mode?: string
  client_group_id?: string | null
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  if (caller.role === 'tc') {
    const { data: access } = await service
      .from('employee_company_access')
      .select('company_id')
      .eq('employee_id', user.id)
      .eq('company_id', id)
      .maybeSingle()

    if (!access) {
      return Response.json({ error: 'No access to this company' }, { status: 403 })
    }
  }

  const { data: company, error } = await service
    .from('companies')
    .select('id, name, status, setup_completed, timezone, currency, country, booking_mode, created_at, client_group_id, managed_by')
    .eq('id', id)
    .eq('tmc_id', caller.tmc_id)
    .single()

  if (error || !company) {
    return Response.json({ error: 'Company not found' }, { status: 404 })
  }

  return Response.json({ ok: true, company })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  // tmc_admin only — booking_mode and company identity are not TC-delegable.
  const { data: caller } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (!caller || caller.role !== 'tmc_admin' || !caller.tmc_id) {
    return Response.json({ error: 'Only TMC admins can edit company details' }, { status: 403 })
  }

  const { data: existing } = await service
    .from('companies')
    .select('id')
    .eq('id', id)
    .eq('tmc_id', caller.tmc_id)
    .maybeSingle()

  if (!existing) {
    return Response.json({ error: 'Company not found' }, { status: 404 })
  }

  const body: UpdateCompanyBody = await req.json()
  const { name, timezone, currency, country, booking_mode, client_group_id} = body

  const update: Record<string, string | null> = {}

  if (name !== undefined) {
    const trimmed = name.trim()
    if (!trimmed) {
      return Response.json({ error: 'Company name cannot be empty' }, { status: 400 })
    }
    update.name = trimmed
  }

  if (timezone !== undefined) {
    if (!timezone.trim()) {
      return Response.json({ error: 'Timezone cannot be empty' }, { status: 400 })
    }
    update.timezone = timezone
  }

  if (currency !== undefined) {
    const upper = currency.trim().toUpperCase()
    if (!ALLOWED_CURRENCIES.includes(upper as typeof ALLOWED_CURRENCIES[number])) {
      return Response.json({ error: `Unsupported currency: ${currency}` }, { status: 400 })
    }
    update.currency = upper
  }

  if (country !== undefined) {
    update.country = country.trim()
  }

  if (client_group_id !== undefined) {
    if (client_group_id === null || client_group_id === '') {
      update.client_group_id = null
    } else {
      const { data: clientGroup } = await service
        .from('client_groups')
        .select('id')
        .eq('id', client_group_id)
        .eq('tmc_id', caller.tmc_id)
        .maybeSingle()

      if (!clientGroup) {
        return Response.json({ error: 'Client group not found for this TMC' }, { status: 404 })
      }
      update.client_group_id = client_group_id
    }
  }

  if (booking_mode !== undefined) {
    if (!ALLOWED_BOOKING_MODES.includes(booking_mode as typeof ALLOWED_BOOKING_MODES[number])) {
      return Response.json(
        { error: `Invalid booking_mode: ${booking_mode}. Must be one of ${ALLOWED_BOOKING_MODES.join(', ')}` },
        { status: 400 }
      )
    }
    update.booking_mode = booking_mode
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data: updated, error: updateError } = await service
    .from('companies')
    .update(update)
    .eq('id', id)
    .select('id, name, timezone, currency, country, booking_mode, client_group_id')
    .single()

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true, company: updated })
}