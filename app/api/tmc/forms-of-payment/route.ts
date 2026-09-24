import { createClient } from '@/utils/supabase/server'
import * as fops from '@/app/lib/repositories/fop'
import * as clients from '@/app/lib/repositories/clients'
import * as employees from '@/app/lib/repositories/employees'
import * as tmcs from '@/app/lib/repositories/tmcs'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { parsePageParams, paginateInMemory } from '@/app/lib/pagination'
import { validateRbdSpec } from '@/app/lib/fop/rbdSpec'
import { fopStatus, describeFop, type FopStatus } from '@/app/lib/fop/fopStatus'
import { validateAirlineCode } from '@/app/lib/reference/airlineCode'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'

// ── GET /api/tmc/forms-of-payment ────────────────────────────────────────────
// The TMC's payment methods, filtered by who is asking.
//
// VISIBILITY IS PART OF THIS ROUTE, NOT A LATER ADDITION
// These are payment instruments, so who can see one matters from day one:
//
//   tmc_admin / tc with manage_fops   every FOP at their TMC
//   corporate admin                   FOPs their client owns, plus their own
//   employee                          only their own traveller cards
//
// Enforced here rather than in the UI, and built in now rather than retrofitted
// onto a route that started out returning everything.
//
// Status is DERIVED from `active` plus card expiry, so like deal codes it cannot
// be filtered in SQL without a second definition of "expired" that drifts from
// the one the UI renders. Rows are enriched and paged in memory; a TMC holds
// tens of payment methods, not thousands.
//
// ── POST ─────────────────────────────────────────────────────────────────────
// TMC-side only. A corporate admin can see their own cards but does not create
// the rules that decide when they are used.
// ─────────────────────────────────────────────────────────────────────────────

export const FOP_TYPES = ['card', 'cash'] as const
export const PAYERS = ['agency', 'corporate', 'traveller'] as const
export const CARD_TYPES = ['AX', 'VI', 'CA', 'DC'] as const

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Resolves who is asking before deciding what they may see. Deliberately does
  // NOT go through requireTmcPermission first: a corporate admin is a legitimate
  // caller here, and gating on a TMC permission would 403 them.
  const caller = await employees.identity(db, user.id)
  if (!caller || caller.status === 'deactivated') {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  const isTmcSide = caller.role === 'tmc_admin' || caller.role === 'tc'

  if (isTmcSide) {
    const auth = await requireTmcPermission(db, user.id, 'manage_fops')
    if (!auth.authorized) {
      return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
    }
  }

  const query_ = req.nextUrl.searchParams
  const params = parsePageParams(query_)
  const filterStatus = query_.get('status') as FopStatus | null

  // A corporate caller's TMC comes from their client, since employees on the
  // corporate side carry client_id rather than tmc_id.
  let tmcId = caller.tmc_id
  if (!isTmcSide) {
    if (!caller.client_id) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    tmcId = (await clients.tenancy(db, caller.client_id))?.tmc_id ?? null
  }

  if (!tmcId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const rows = await fops.listForTmc(db, tmcId, {
    ids: query_.get('ids')?.split(',').filter(Boolean),
    type: query_.get('type'),
    payer: query_.get('payer'),
    // Corporate Settings shows the cards one client owns. Filtered in SQL
    // rather than in the browser because this list is paged at ten — filtering
    // a page would show "no cards" for a client whose card happens to sit on
    // page two, which is worse than showing nothing at all.
    ownerClientId: query_.get('ownerClientId'),
    // fop_code included: it is the short identifier a counsellor actually
    // says out loud, so it is the first thing anyone searches by.
    search: params.search,
  })

  // The visibility rules, applied after the fetch because they are about
  // ownership rather than tenancy and read more clearly as one predicate than
  // as three query branches.
  const visible = rows.filter(fop => {
    if (isTmcSide) return true
    if (caller.role === 'admin') {
      // A corporate admin sees their company's own cards and their own.
      return fop.owner_client_id === caller.client_id || fop.owner_employee_id === caller.id
    }
    return fop.owner_employee_id === caller.id
  })

  const enriched = visible.map(fop => ({
    ...fop,
    status: fopStatus(fop),
    description: describeFop(fop),
  }))

  const filtered = filterStatus ? enriched.filter(f => f.status === filterStatus) : enriched

  return Response.json(paginateInMemory(filtered, params))
})

interface CreateBody {
  fop_code?: string | null
  label: string
  gds_entry_id?: string | null
  payment_type_id?: string | null
  fop_type: string
  payer: string
  card_type?: string | null
  last4?: string | null
  expiry_month?: number | null
  expiry_year?: number | null
  gds_alias?: string | null
  branch_id?: string | null
  owner_client_id?: string | null
  owner_employee_id?: string | null
  airline_code?: string | null
  rbd_spec?: string | null
  active?: boolean
  is_default?: boolean
  notes?: string | null
}

// ── deriveFopType ────────────────────────────────────────────────────────────
// Sets fop_type from the chosen payment type's requires_card flag, and checks
// both code-list references belong to this TMC.
//
// Those are plain FKs, so another tenant's payment type would satisfy the
// constraint. Checked here for the same reason branch and owner are.
//
// A form of payment with no payment type set keeps whatever fop_type it was
// given: the field is optional, and refusing to save without it would make the
// code lists mandatory rather than useful.
export async function deriveFopType<T extends Partial<CreateBody>>(
  tmcId: string,
  body: T
): Promise<{ body: T } | { error: string; status: number }> {
  const next = { ...body }

  if (next.gds_entry_id && !(await fops.gdsEntryInTmc(db, next.gds_entry_id, tmcId))) {
    return { error: 'That GDS entry does not belong to your TMC', status: 422 }
  }

  if (next.payment_type_id) {
    const paymentType = await fops.paymentTypeInTmc(db, next.payment_type_id, tmcId)
    if (!paymentType) return { error: 'That payment type does not belong to your TMC', status: 422 }
    next.fop_type = paymentType.requires_card ? 'card' : 'cash'
  }

  return { body: next }
}

// ── checkReferences ──────────────────────────────────────────────────────────
// Every referenced row is checked against this TMC. branch_id, owner_client_id
// and owner_employee_id are plain FKs, so another tenant's id would satisfy
// the constraint and quietly attach their branch or their client's card.
//
// Shared by POST and PATCH. PATCH used to check the branch alone, so an edit
// could hang this TMC's card on another tenant's client or traveller.
// Returns the error to report, or null.
export async function checkReferences(tmcId: string, body: Partial<CreateBody>): Promise<string | null> {
  if (body.branch_id && !(await tmcs.branchInTmc(db, body.branch_id, tmcId))) {
    return 'That branch does not belong to your TMC'
  }
  if (body.owner_client_id && (await clients.tenancy(db, body.owner_client_id))?.tmc_id !== tmcId) {
    return 'That client does not belong to your TMC'
  }
  // An employee belongs to a client, which belongs to the TMC — so the check
  // goes one hop further than the two above.
  if (body.owner_employee_id && (await employees.tmcOfTraveller(db, body.owner_employee_id)) !== tmcId) {
    return 'That traveller does not belong to your TMC'
  }
  return null
}

// fop_code is unique per TMC. A clash is the user's to fix, not a fault.
export const FOP_CODE_TAKEN = 'fop_code_uniq'

// ── normaliseFop ─────────────────────────────────────────────────────────────
// Clears the fields the chosen type and payer make meaningless, so a stale
// value left behind by a form the user has since switched cannot fail a save.
//
// This is CLEARING, not validating, and the distinction matters: someone who
// picks cash has said unambiguously that the card brand is irrelevant. Making
// them hunt for a hidden field to empty first is friction with no safety in it.
//
// Run by both POST and PATCH so create and edit cannot disagree — they did,
// and that was the bug.
export function normaliseFop<T extends Partial<CreateBody>>(body: T): T {
  const next = { ...body }

  if (next.fop_type === 'cash') {
    next.card_type = null
    next.last4 = null
    next.expiry_month = null
    next.expiry_year = null
  }

  // An agency card is the TMC's own, so it has no owner. A corporate card
  // belongs to a client and a traveller card to a person — never both.
  if (next.payer === 'agency') {
    next.owner_client_id = null
    next.owner_employee_id = null
  } else if (next.payer === 'corporate') {
    next.owner_employee_id = null
  } else if (next.payer === 'traveller') {
    next.owner_client_id = null
  }

  return next
}

// Shared with PATCH in [id]. Returns an error string or null.
//
// Expects an already-normalised body: the rules below are about input that is
// genuinely contradictory, not input that merely carries fields the user has
// since made irrelevant.
//
// The card/cash and payer/owner rules are also DB CHECK constraints. Repeated
// here so the message names the field rather than surfacing a raw constraint
// violation as a 500.
export function validateFop(body: Partial<CreateBody>): string | null {
  if (body.label !== undefined && !body.label.trim()) {
    return 'Give this a label — it is what a counsellor picks it by.'
  }

  if (body.fop_type !== undefined && !FOP_TYPES.includes(body.fop_type as typeof FOP_TYPES[number])) {
    return `Unknown payment type: ${body.fop_type}`
  }

  if (body.payer !== undefined && !PAYERS.includes(body.payer as typeof PAYERS[number])) {
    return `Unknown payer: ${body.payer}`
  }

  // Card fields on a cash FOP are NOT an error — see normaliseFop below, which
  // clears them before this runs. Rejecting here was a real bug: the editor
  // defaults card_type to 'AX', so switching to cash and saving failed with
  // "Cash settlement cannot carry card details" on a form showing no card
  // fields at all. PATCH already normalised; POST refused. Same input, two
  // answers depending on whether you were creating or editing.

  if (body.fop_type === 'card') {
    if (!body.card_type) return 'Pick a card type.'
    if (!CARD_TYPES.includes(body.card_type as typeof CARD_TYPES[number])) {
      return `Unknown card type: ${body.card_type}`
    }
  }

  // Never a full card number. The column does not exist and this is the second
  // line of defence for anyone posting straight at the API.
  if (body.last4 !== undefined && body.last4 !== null && body.last4 !== '') {
    if (!/^[0-9]{4}$/.test(body.last4)) {
      return 'Enter only the last four digits — full card numbers are never stored.'
    }
  }

  if (body.expiry_month != null && (body.expiry_month < 1 || body.expiry_month > 12)) {
    return 'Expiry month must be between 1 and 12.'
  }

  if (body.payer === 'corporate' && !body.owner_client_id) {
    return 'A corporate card belongs to a client — pick which one.'
  }
  if (body.payer === 'traveller' && !body.owner_employee_id) {
    return 'A traveller card belongs to a person — pick who.'
  }
  if (body.payer === 'agency' && (body.owner_client_id || body.owner_employee_id)) {
    return 'An agency card is the TMC’s own — it cannot have an owner.'
  }

  // Blank is valid here and means "every airline" — validateAirlineCode treats
  // an empty value as acceptable for exactly that reason.
  const airlineError = validateAirlineCode(body.airline_code)
  if (airlineError) return airlineError

  return validateRbdSpec(body.rbd_spec)
}

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_fops')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  const raw = (await req.json()) as CreateBody

  // fop_type is DERIVED from the payment type rather than picked separately.
  // Two fields answering "does this need card details" is exactly how they end
  // up disagreeing — a CC payment type on a cash FOP. The payment type's
  // requires_card flag is the one source of truth; this reads it and normalise
  // then clears the card fields if it says no.
  const derived = await deriveFopType(tmcId, raw)
  if ('error' in derived) {
    return Response.json({ error: derived.error }, { status: derived.status })
  }

  const body = normaliseFop(derived.body)

  const validationError = validateFop(body)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  const foreign = await checkReferences(tmcId, body)
  if (foreign) {
    return Response.json({ error: foreign }, { status: 422 })
  }

  const isCard = body.fop_type === 'card'

  // Ticking default is a SWAP, which is what anyone ticking the box means: the
  // old holder is cleared first, in the SAME transaction, so the one-per-TMC
  // index never rejects the write -- and a write that fails for any other
  // reason no longer leaves the TMC with no default at all.
  try {
    const created = await transaction(async (tx) => {
      if (body.is_default) await fops.clearDefault(tx, tmcId)
      return fops.insertFop(tx, {
        tmc_id: tmcId,
        fop_code: body.fop_code?.trim().toUpperCase() || null,
        label: body.label.trim(),
        gds_entry_id: body.gds_entry_id || null,
        payment_type_id: body.payment_type_id || null,
        fop_type: body.fop_type,
        payer: body.payer,
        card_type: isCard ? body.card_type ?? null : null,
        last4: isCard ? body.last4 || null : null,
        expiry_month: isCard ? body.expiry_month ?? null : null,
        expiry_year: isCard ? body.expiry_year ?? null : null,
        gds_alias: body.gds_alias?.trim() || null,
        branch_id: body.branch_id || null,
        owner_client_id: body.owner_client_id || null,
        owner_employee_id: body.owner_employee_id || null,
        airline_code: body.airline_code?.trim().toUpperCase() || null,
        rbd_spec: body.rbd_spec?.trim().toUpperCase() || null,
        active: body.active ?? true,
        is_default: body.is_default ?? false,
        notes: body.notes?.trim() || null,
        created_by: user.id,
      })
    }, { tenantId: tmcId, userId: user.id })

    return Response.json({
      ok: true,
      fop: { ...created, status: fopStatus(created), description: describeFop(created) },
    })
  } catch (err) {
    if (isConstraint(err, 'unique', FOP_CODE_TAKEN)) {
      return Response.json(
        { error: `Another form of payment already uses the code "${body.fop_code?.trim().toUpperCase()}"` },
        { status: 409 }
      )
    }
    throw err
  }
})
