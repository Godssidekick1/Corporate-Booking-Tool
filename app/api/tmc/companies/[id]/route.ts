import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/companies/[id] ─────────────────────────────────────────────
// Full detail view of one client company, for the TMC admin.
//
// ── PATCH /api/tmc/companies/[id] ───────────────────────────────────────────
// TMC admin edits a client company's identity fields, including booking_mode —
// which only the TMC can set. Scoped so a TMC admin can only touch companies
// that belong to their own TMC (tmc_id match), never another TMC's clients.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_CURRENCIES = ['INR'] as const
const ALLOWED_BOOKING_MODES = ['sbt', 'cbt', 'both'] as const

interface UpdateCompanyBody {
  name?: string
  timezone?: string
  currency?: string
  country?: string
  booking_mode?: string
}

async function getTmcCaller(userId: string, service: ReturnType<typeof createServiceClient>) {
  const { data: caller, error } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', userId)
    .single()

  if (error || !caller || caller.role !== 'tmc_admin' || !caller.tmc_id) return null
  return caller
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
  const caller = await getTmcCaller(user.id, service)

  if (!caller) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: company, error } = await service
    .from('companies')
    .select('id, name, status, setup_completed, timezone, currency, country, booking_mode, created_at, branch_id, managed_by')
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
  const caller = await getTmcCaller(user.id, service)

  if (!caller) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Confirm the target company actually belongs to this TMC before writing.
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
  const { name, timezone, currency, country, booking_mode } = body

  const update: Record<string, string> = {}

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
    .select('id, name, timezone, currency, country, booking_mode')
    .single()

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true, company: updated })
}