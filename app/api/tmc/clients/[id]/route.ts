import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/clients/[id] ─────────────────────────────────────────────
// Full detail view of one client client. tmc_admin sees any of their
// clients; a TC needs explicit access to this specific client.
//
// ── PATCH /api/tmc/clients/[id] ───────────────────────────────────────────
// tmc_admin only — client identity fields including booking_mode are a
// TMC-exclusive edit, not delegable to TCs via the permission system.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_CURRENCIES = ['INR'] as const
const ALLOWED_BOOKING_MODES = ['sbt', 'cbt', 'both'] as const

// Must match the CHECK constraint on clients.size. Validated here rather than
// trusted from the select, since a PATCH is just an HTTP call — sending an
// unlisted value would surface as a raw constraint violation and a 500.
const ALLOWED_SIZES = ['1-50', '51-200', '201-1000', '1001+'] as const

// setup_completed is deliberately absent: it is derived onboarding progress,
// not a setting someone toggles.
const ALLOWED_STATUSES = ['active', 'inactive'] as const

interface UpdateClientBody {
  name?: string
  timezone?: string
  currency?: string
  country?: string
  booking_mode?: string
  client_group_id?: string | null
  // These four columns have existed on `clients` since onboarding was built —
  // onboardClient writes them — but nothing could edit them afterwards, so a
  // typo in a GST number at creation was permanent.
  registered_address?: string | null
  gst_number?: string | null
  industry?: string | null
  primary_contact_phone?: string | null
  size?: string | null
  status?: string
  // Which of the TMC's own staff owns this client. The column has existed as a
  // foreign key to employees since the schema was created and has never been
  // set or displayed anywhere.
  managed_by?: string | null
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
      .from('employee_client_access')
      .select('client_id')
      .eq('employee_id', user.id)
      .eq('client_id', id)
      .maybeSingle()

    if (!access) {
      return Response.json({ error: 'No access to this client' }, { status: 403 })
    }
  }

  const { data: client, error } = await service
    .from('clients')
    .select('id, name, status, setup_completed, timezone, currency, country, booking_mode, created_at, client_group_id, managed_by, registered_address, gst_number, industry, primary_contact_phone')
    .eq('id', id)
    .eq('tmc_id', caller.tmc_id)
    .single()

  if (error || !client) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  return Response.json({ ok: true, client })
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

  // tmc_admin only — booking_mode and client identity are not TC-delegable.
  const { data: caller } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (!caller || caller.role !== 'tmc_admin' || !caller.tmc_id) {
    return Response.json({ error: 'Only TMC admins can edit client details' }, { status: 403 })
  }

  const { data: existing } = await service
    .from('clients')
    .select('id')
    .eq('id', id)
    .eq('tmc_id', caller.tmc_id)
    .maybeSingle()

  if (!existing) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  const body: UpdateClientBody = await req.json()
  const { name, timezone, currency, country, booking_mode, client_group_id} = body

  const update: Record<string, string | null> = {}

  if (name !== undefined) {
    const trimmed = name.trim()
    if (!trimmed) {
      return Response.json({ error: 'Client name cannot be empty' }, { status: 400 })
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

  // Free-text client details. Empty string clears rather than storing '' — a
  // blank GST field should read as "not recorded", and every consumer already
  // handles null.
  //
  // GST is uppercased because Indian GSTINs are canonically uppercase and a
  // lowercase copy would not match anything searched for later. It is
  // deliberately NOT format-validated: this is a TMC recording what a client
  // told them, and rejecting an unusual-but-real identifier is worse than
  // storing one that needs correcting.
  if (body.registered_address !== undefined) {
    update.registered_address = body.registered_address?.trim() || null
  }
  if (body.gst_number !== undefined) {
    update.gst_number = body.gst_number?.trim().toUpperCase() || null
  }
  if (body.industry !== undefined) {
    update.industry = body.industry?.trim() || null
  }
  if (body.primary_contact_phone !== undefined) {
    update.primary_contact_phone = body.primary_contact_phone?.trim() || null
  }

  if (body.size !== undefined) {
    const size = body.size?.trim() || null
    if (size && !ALLOWED_SIZES.includes(size as typeof ALLOWED_SIZES[number])) {
      return Response.json(
        { error: `Invalid size: ${size}. Must be one of ${ALLOWED_SIZES.join(', ')}` },
        { status: 400 }
      )
    }
    update.size = size
  }

  if (body.status !== undefined) {
    if (!ALLOWED_STATUSES.includes(body.status as typeof ALLOWED_STATUSES[number])) {
      return Response.json(
        { error: `Invalid status: ${body.status}. Must be one of ${ALLOWED_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }
    update.status = body.status
  }

  if (body.managed_by !== undefined) {
    if (!body.managed_by) {
      update.managed_by = null
    } else {
      // Restricted to TMC-side staff at THIS TMC. managed_by is a plain FK to
      // employees, so a corporate employee's id would satisfy the constraint
      // and produce an account manager who doesn't work for the TMC.
      const { data: manager } = await service
        .from('employees')
        .select('id, role, tmc_id')
        .eq('id', body.managed_by)
        .eq('tmc_id', caller.tmc_id)
        .in('role', ['tmc_admin', 'tc'])
        .maybeSingle()

      if (!manager) {
        return Response.json(
          { error: 'Account manager must be a member of your TMC' },
          { status: 422 }
        )
      }
      update.managed_by = body.managed_by
    }
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
    .from('clients')
    .update(update)
    .eq('id', id)
    .select('id, name, timezone, currency, country, booking_mode, client_group_id, registered_address, gst_number, industry, primary_contact_phone, size, status, managed_by')
    .single()

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true, client: updated })
}