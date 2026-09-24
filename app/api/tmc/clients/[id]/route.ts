import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { PAYMENT_TYPES, type PaymentType } from '@/app/lib/fop/paymentTypes'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as tmcs from '@/app/lib/repositories/tmcs'
import { route } from '@/app/lib/http/handler'

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
// GET and PATCH return the same record (clients.ClientSettings, one column list
// in the repository), so they cannot disagree about what a client is. They
// once did: `size` was in the PATCH's returning select but NOT in the GET's, so
// the detail screen loaded the field blank and wrote that blank back on the
// next save.

// Free text: trimmed, empty becomes NULL. A blank contact should read as "not
// recorded", and every consumer already handles null.
const TEXT_FIELDS = [
  'registered_address', 'industry', 'primary_contact_phone',
  'client_code', 'sap_customer_code', 'sap_group_code', 'email', 'phone',
  'address_1', 'address_2', 'city', 'state', 'pincode',
  'collections_name', 'collections_email', 'collections_mobile',
] as const

// Uppercased on write. A client code is canonically uppercase, and a lowercase
// copy would not match anything searched for later. GSTINs used to be here too;
// they live on client_gst_registrations now, because a corporate bills through
// several of them and one column could hold one.
const UPPERCASE_FIELDS = ['client_code'] as const

// The Corporate Settings toggles. Booleans only — anything not a boolean is
// ignored rather than coerced, so a stray "false" string cannot switch booking
// off for a whole company.
const BOOLEAN_FIELDS = [
  'booking_activation', 'hold_activation', 'dom_ticketing', 'intl_ticketing',
  'hold_auto_issue', 'sbt_ticketing', 'policy_controlling', 'personal_bookings_allowed',
  'agency_fop_allowed', 'corporate_fop_allowed',
  // "Traveller pays" splits in two: bta_cta is their card already stored here,
  // bta_cta_manual is them typing it at the gateway. See app/lib/fop/paymentTypes.ts
  // — in this product those letters mean the traveller's card, not a corporate
  // lodged account.
  'bta_cta_allowed', 'bta_cta_manual_allowed',
  // The commercial switches. discount_active and processing_fee_active were
  // recorded-only until the commercial rules engine landed; all three now decide
  // whether a rule of that kind is applied to this client's fares.
  'markup_active', 'discount_active', 'processing_fee_active',
] as const

type UpdateClientBody = {
  name?: string
  timezone?: string
  currency?: string
  country?: string
  booking_mode?: string
  client_group_id?: string | null
  size?: string | null
  // Preference order over the four payment types. Always all four — the
  // booleans above say which are in play, this says which wins when several are.
  fop_priority?: string[]
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

type Ctx = { params: Promise<{ id: string }> }

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const caller = await employees.accessProfile(db, user.id)

  if (!caller || !caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (caller.role === 'tc' && !(await employees.hasClientAccess(db, user.id, id))) {
    return Response.json({ error: 'No access to this client' }, { status: 403 })
  }

  const client = await clients.settings(db, id, caller.tmc_id)

  if (!client) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  return Response.json({ ok: true, client })
})

export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_clients', id)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId!

  if (!(await clients.statusInTmc(db, id, tmcId))) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  const body: UpdateClientBody = await req.json()
  const { name, timezone, currency, country, booking_mode, client_group_id } = body

  const update: clients.ClientSettingsEdit = {}

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
    const value = body[field]
    if (typeof value === 'boolean') update[field] = value
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
    const value: unknown = body[field]
    if (value === undefined) continue
    update[field] = (typeof value === 'string' ? value.trim().toUpperCase() : '') || null
  }

  for (const mode of ['air_approval_mode', 'hotel_approval_mode'] as const) {
    const value = body[mode]
    if (value === undefined) continue
    if (!ALLOWED_APPROVAL_MODES.includes(value as typeof ALLOWED_APPROVAL_MODES[number])) {
      return Response.json({ error: `Invalid ${mode}: ${value}` }, { status: 400 })
    }
    update[mode] = value
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

  // The same four values, each exactly once. Validated here as well as by the
  // CHECK constraint so a bad payload reads as a 400 explaining itself rather
  // than a 500 quoting a constraint name.
  //
  // Buckets used to be set from this route — three columns naming one bucket
  // each. They are gone: bucket membership is the mechanism the resolvers
  // actually read, and it is edited at PUT /api/tmc/clients/[id]/buckets.
  if (body.fop_priority !== undefined) {
    const order = body.fop_priority
    const valid =
      Array.isArray(order) &&
      order.length === PAYMENT_TYPES.length &&
      new Set(order).size === PAYMENT_TYPES.length &&
      order.every(t => PAYMENT_TYPES.includes(t as PaymentType))

    if (!valid) {
      return Response.json(
        { error: `fop_priority must list each of ${PAYMENT_TYPES.join(', ')} exactly once` },
        { status: 400 }
      )
    }
    update.fop_priority = order
  }

  if (body.managed_by !== undefined) {
    if (!body.managed_by) {
      update.managed_by = null
    } else {
      // Restricted to TMC-side staff at THIS TMC. managed_by is a plain FK to
      // employees, so a corporate employee's id would satisfy the constraint
      // and produce an account manager who doesn't work for the TMC.
      if (!(await employees.isTmcStaff(db, body.managed_by, tmcId))) {
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
      if (!(await tmcs.branchInTmc(db, body.branch_id, tmcId))) {
        return Response.json({ error: 'Branch not found for this TMC' }, { status: 422 })
      }
      update.branch_id = body.branch_id
    }
  }

  if (client_group_id !== undefined) {
    if (client_group_id === null || client_group_id === '') {
      update.client_group_id = null
    } else {
      if (!(await clients.groupInTmc(db, client_group_id, tmcId))) {
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

  let updated: clients.ClientSettings | null
  try {
    // Scoped to the TMC in the write itself, not only by the check above: the
    // two are separate statements.
    updated = await clients.updateSettings(db, id, tmcId, update)
  } catch (err) {
    // The partial unique index on (tmc_id, client_code) surfaces as a raw
    // constraint name otherwise, which says nothing about what to fix.
    if (isConstraint(err, 'unique')) {
      return Response.json(
        { error: `Client code "${body.client_code}" is already used by another client.` },
        { status: 409 }
      )
    }
    throw err
  }

  if (!updated) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  return Response.json({ ok: true, client: updated })
})

// ── DELETE /api/tmc/clients/[id] ─────────────────────────────────────────────
// Deactivates a client. It does NOT remove the row, and the method name is the
// only thing about this that says "delete".
//
// A client owns bookings with real PNRs, tickets that have been paid for, GST
// registrations a finance team reconciles against, and commercial assignments
// that explain what past bookings were charged. Hard-deleting cascades through
// all of it — `bookings` alone would either be orphaned or destroyed — so what a
// TMC means by "remove this client" is: their people stop getting in, they stop
// appearing in the lists, and the history stays. That is a status change.
//
// Same reasoning, and the same shape, as DELETE /api/trips/[tripId], which
// soft-deletes for exactly this reason: "a trip can have real bookings (PNRs,
// money already spent with an airline)".
//
// Reversible by design: PATCH { status: 'active' } puts them back, and nothing
// about the client was altered in the meantime. The clients list offers that as
// Reactivate.
//
// WHAT ACTUALLY ENFORCES IT lives in two places, because the status column had
// never been read by anything before this:
//   • app/api/auth/signin — their people can no longer sign in
//   • app/lib/clients/clientGates — booking, hold and ticketing all close, which
//     covers any session still open when the switch was thrown
// ─────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // manage_clients, matching PATCH. Deactivating a client is a bigger act than
  // editing one, so anything narrower would be wrong.
  const auth = await requireTmcPermission(db, user.id, 'manage_clients', id)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId!

  const existing = await clients.statusInTmc(db, id, tmcId)

  if (!existing) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  // Idempotent. Deactivating an already-inactive client is not an error — it is
  // someone clicking twice, or two people clicking at once.
  if (existing.status === 'inactive') {
    return Response.json({ ok: true, client: { id: existing.id, status: 'inactive' } })
  }

  const updated = await clients.setStatus(db, id, tmcId, 'inactive')

  if (!updated) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  return Response.json({ ok: true, client: updated })
})
