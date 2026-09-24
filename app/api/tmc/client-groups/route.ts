import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, pagedResponse } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db, isConstraint } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── GET /api/tmc/client-groups ────────────────────────────────────────────────
// List all client groups for this TMC. Any TMC-side caller can view.
//
// ── POST /api/tmc/client-groups ───────────────────────────────────────────────
// Create a new client group. Requires manage_client_groups permission (or tmc_admin).
//
// A client group is the CLIENT'S OWN org structure — Acme Group above Acme India
// and Acme UK — and a client belongs to at most one. Not a bucket (an arbitrary
// curated set for distribution, which a client can be in many of), and not a
// branch (one of the TMC's own offices).
//
// The address here is a BILL-TO address: the group is who receives an invoice,
// where a branch is who raises one. No GST number — the client's GSTIN lives on
// `clients`, which is the entity that contracts, and a second copy here would
// simply be a second answer that could disagree.
// ─────────────────────────────────────────────────────────────────────────────

// Every free-text field, with the trim-or-null treatment applied uniformly.
// Empty string is stored as NULL rather than '': a blank contact should read as
// "not recorded", and every consumer already handles null.
export const CLIENT_GROUP_TEXT_FIELDS = [
  'group_code',
  'city', 'country',
  'contact_first_name', 'contact_last_name', 'contact_email', 'contact_mobile',
  'bill_to_address_1', 'bill_to_address_2', 'bill_to_state', 'bill_to_pincode',
] as const

export type ClientGroupTextField = typeof CLIENT_GROUP_TEXT_FIELDS[number]

export type ClientGroupBody = { name?: string } & Partial<Record<ClientGroupTextField, string | null>>

// ── normaliseClientGroup ─────────────────────────────────────────────────────
// Trims, uppercases the code, and turns blanks into NULL. Shared by POST and
// PATCH so create and edit cannot disagree — the exact drift that produced the
// "Cash settlement cannot carry card details" bug on forms of payment.
export function normaliseClientGroup(body: ClientGroupBody): clients.ClientGroupFields {
  const update: clients.ClientGroupFields = {}

  for (const field of CLIENT_GROUP_TEXT_FIELDS) {
    if (body[field] === undefined) continue
    const value = body[field]?.trim() || null
    // Codes are canonically uppercase, and a lowercase copy would not match
    // anything anyone searched for later.
    update[field] = field === 'group_code' ? value?.toUpperCase() ?? null : value
  }

  return update
}

// Deliberately light. This is a TMC recording what a client told them, and
// rejecting an unusual-but-real value is worse than storing one that needs
// correcting later — the same call already made for GST numbers on branches and
// clients. Only outright nonsense is refused.
export function validateClientGroup(body: ClientGroupBody): string | null {
  if (body.name !== undefined && !body.name.trim()) {
    return 'Client group name cannot be empty'
  }

  const email = body.contact_email?.trim()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return `"${email}" is not a valid email address.`
  }

  return null
}

// The partial unique index on (tmc_id, group_code) surfaces as a raw
// constraint name otherwise, which tells the user nothing about what to fix.
export function duplicateCode(code: string | null | undefined): Response {
  return Response.json(
    { error: `Group code "${code}" is already used by another group.` },
    { status: 409 }
  )
}

interface CreateClientGroupBody extends ClientGroupBody {
  name: string
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const caller = await employees.accessProfile(db, user.id)

  if (!caller || !caller.tmc_id || (caller.role !== 'tmc_admin' && caller.role !== 'tc')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const params = parsePageParams(req.nextUrl.searchParams)
  const ids = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) ?? []

  // group_code is searched too: it is the short reference people actually use,
  // so it is the first thing anyone searches by.
  const { rows, total } = await clients.groupsForTmc(
    db,
    caller.tmc_id,
    ids.length > 0 ? { ids } : { search: params.search, page: params }
  )

  return Response.json(pagedResponse(rows, total, params))
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_client_groups')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const body: CreateClientGroupBody = await req.json()

  if (!body.name?.trim()) {
    return Response.json({ error: 'Client group name is required' }, { status: 400 })
  }

  const validationError = validateClientGroup(body)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  try {
    const clientGroup = await clients.insertGroup(db, auth.tmcId, {
      name: body.name.trim(),
      ...normaliseClientGroup(body),
    })
    return Response.json({ ok: true, clientGroup }, { status: 201 })
  } catch (err) {
    if (isConstraint(err, 'unique')) return duplicateCode(body.group_code)
    throw err
  }
})
