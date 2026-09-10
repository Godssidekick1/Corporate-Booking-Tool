import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/clients/[id] ─────────────────────────────────────────────
// Full detail view of one client client. tmc_admin sees any of their
// clients; a TC needs explicit access to this specific client.
//
// ── PATCH /api/tmc/clients/[id] ───────────────────────────────────────────
// tmc_admin, or a TC holding `manage_clients` who also has access to this
// specific client. It used to be tmc_admin-only. Correcting a client's GST
// number or phone is exactly the kind of routine account work a senior
// counsellor does, and forcing it through an admin made the admin a bottleneck
// rather than a control.
//
// The client-id argument to requireTmcPermission is what keeps it honest: the
// permission alone is not enough, the TC must also be assigned to this client.
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

const ALLOWED_APPROVAL_MODES = ['before_booking', 'not_required'] as const

// ── The Corporate Settings surface ───────────────────────────────────────────
// Every column this route reads and writes, in one place, so GET and PATCH
// cannot disagree about what a client is. They already did: `size` was in the
// PATCH's returning select but NOT in the GET's, so the detail screen loaded the
// field blank and wrote that blank back on the next save. Anyone who had ever
// set a client's size had since silently lost it.
export const CLIENT_COLUMNS =
  'id, name, status, setup_completed, timezone, currency, country, booking_mode, created_at, ' +
  'client_group_id, managed_by, branch_id, ' +
  'registered_address, gst_number, industry, primary_contact_phone, size, ' +
  'client_code, sap_customer_code, sap_group_code, email, phone, ' +
  'address_1, address_2, city, state, pincode, ' +
  'collections_name, collections_email, collections_mobile, ' +
  'booking_activation, hold_activation, dom_ticketing, intl_ticketing, ' +
  'hold_auto_issue, sbt_ticketing, policy_controlling, personal_bookings_allowed, ' +
  'agency_fop_allowed, corporate_fop_allowed, traveller_fop_allowed, ' +
  'discount_active, processing_fee_active, ' +
  'fop_bucket_id, discount_bucket_id, processing_fee_bucket_id, ' +
  'air_approval_mode, hotel_approval_mode'

// Free text: trimmed, empty becomes NULL. A blank contact should read as "not
// recorded", and every consumer already handles null.
const TEXT_FIELDS = [
  'registered_address', 'industry', 'primary_contact_phone',
  'client_code', 'sap_customer_code', 'sap_group_code', 'email', 'phone',
  'address_1', 'address_2', 'city', 'state', 'pincode',
  'collections_name', 'collections_email', 'collections_mobile',
] as const

// Uppercased on write. GSTINs and client codes are canonically uppercase, and a
// lowercase copy would not match anything searched for later.
const UPPERCASE_FIELDS = new Set<string>(['gst_number', 'client_code'])

// The Corporate Settings toggles. Booleans only — anything not a boolean is
// ignored rather than coerced, so a stray "false" string cannot switch booking
// off for a whole company.
const BOOLEAN_FIELDS = [
  'booking_activation', 'hold_activation', 'dom_ticketing', 'intl_ticketing',
  'hold_auto_issue', 'sbt_ticketing', 'policy_controlling', 'personal_bookings_allowed',
  'agency_fop_allowed', 'corporate_fop_allowed', 'traveller_fop_allowed',
  'discount_active', 'processing_fee_active',
] as const

const BUCKET_FIELDS = ['fop_bucket_id', 'discount_bucket_id', 'processing_fee_bucket_id'] as const

type UpdateClientBody = {
  name?: string
  timezone?: string
  currency?: string
  country?: string
  booking_mode?: string
  client_group_id?: string | null
  gst_number?: string | null
  size?: string | null
  status?: string
  // Which of the TMC's own staff owns this client — the KAM on the old screen.
  managed_by?: string | null
  // The TMC branch servicing this client. Drives which branch-scoped form of
  // payment applies to their bookings, and is the Sales Office / Branch Location
  // the old screen shows three separate ways.
  branch_id?: string | null
  air_approval_mode?: string
  hotel_approval_mode?: string
} & Partial<Record<typeof TEXT_FIELDS[number], string | null>>
  & Partial<Record<typeof BOOLEAN_FIELDS[number], boolean>>
  & Partial<Record<typeof BUCKET_FIELDS[number], string | null>>

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
    .select(CLIENT_COLUMNS)
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

  const auth = await requireTmcPermission(service, user.id, 'manage_clients', id)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId!

  const { data: existing } = await service
    .from('clients')
    .select('id')
    .eq('id', id)
    .eq('tmc_id', tmcId)
    .maybeSingle()

  if (!existing) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  const body: UpdateClientBody = await req.json()
  const { name, timezone, currency, country, booking_mode, client_group_id} = body

  const update: Record<string, string | boolean | null> = {}

  // Free text, uniformly. Empty clears rather than storing '' — a blank GST
  // field should read as "not recorded", and every consumer already handles
  // null. GST and client code are uppercased; neither is format-validated,
  // because this is a TMC recording what a client told them and rejecting an
  // unusual-but-real identifier is worse than storing one that needs fixing.
  for (const field of TEXT_FIELDS) {
    if (body[field] === undefined) continue
    update[field] = body[field]?.trim() || null
  }

  // Booleans only. A stray "false" string would be truthy, and switching
  // booking off for a whole company on a type coercion is not a failure mode
  // worth allowing.
  for (const field of BOOLEAN_FIELDS) {
    if (typeof body[field] === 'boolean') update[field] = body[field]
  }

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

  for (const field of UPPERCASE_FIELDS) {
    const value = (body as Record<string, unknown>)[field]
    if (value === undefined) continue
    update[field] = (typeof value === 'string' ? value.trim().toUpperCase() : '') || null
  }

  for (const mode of ['air_approval_mode', 'hotel_approval_mode'] as const) {
    if (body[mode] === undefined) continue
    if (!ALLOWED_APPROVAL_MODES.includes(body[mode] as typeof ALLOWED_APPROVAL_MODES[number])) {
      return Response.json({ error: `Invalid ${mode}: ${body[mode]}` }, { status: 400 })
    }
    update[mode] = body[mode]
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

  // Every bucket verified against this TMC, for the same reason branch_id is
  // below: these are plain FKs, so another tenant's bucket would satisfy the
  // constraint and quietly attach their curated client set to this client's
  // commercial arrangement.
  for (const field of BUCKET_FIELDS) {
    if (body[field] === undefined) continue
    if (!body[field]) { update[field] = null; continue }

    const { data: bucket } = await service
      .from('buckets')
      .select('id')
      .eq('id', body[field])
      .eq('tmc_id', tmcId)
      .maybeSingle()

    if (!bucket) {
      return Response.json({ error: 'Bucket not found for this TMC' }, { status: 422 })
    }
    update[field] = body[field]
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
        .eq('tmc_id', tmcId)
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

  if (body.branch_id !== undefined) {
    if (!body.branch_id) {
      update.branch_id = null
    } else {
      // Verified against this TMC: branch_id is a plain FK, so another tenant's
      // branch would satisfy the constraint and silently drive this client's
      // form-of-payment resolution.
      const { data: branch } = await service
        .from('branches')
        .select('id')
        .eq('id', body.branch_id)
        .eq('tmc_id', tmcId)
        .maybeSingle()

      if (!branch) {
        return Response.json({ error: 'Branch not found for this TMC' }, { status: 422 })
      }
      update.branch_id = body.branch_id
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
        .eq('tmc_id', tmcId)
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

  // The SAME column list the GET uses. These two having their own lists is what
  // let `size` be returned by one and not the other, so the screen loaded it
  // blank and wrote the blank back.
  const { data: updated, error: updateError } = await service
    .from('clients')
    .update(update)
    .eq('id', id)
    .select(CLIENT_COLUMNS)
    .single()

  if (updateError) {
    // The partial unique index on (tmc_id, client_code) surfaces as a raw
    // constraint name otherwise, which says nothing about what to fix.
    if (updateError.code === '23505') {
      return Response.json(
        { error: `Client code "${body.client_code}" is already used by another client.` },
        { status: 409 }
      )
    }
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true, client: updated })
}