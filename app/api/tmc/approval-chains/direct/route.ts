import { createClient } from '@/utils/supabase/server'
import * as approvals from '@/app/lib/repositories/approvals'
import * as clients from '@/app/lib/repositories/clients'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { APPROVAL_CATEGORIES } from '@/app/lib/approval-engine/resolveApprovalTier'
import { NextRequest } from 'next/server'
import { db, transaction, isConstraint } from '@/app/lib/db'

// ── /api/tmc/approval-chains/direct ──────────────────────────────────────────
// One request, one whole chain: pick a client, pick who it covers, list the
// approvers in order, choose sequential or parallel, save.
//
// The structure/identity split still exists underneath — a client-owned
// template holds the steps, approval_tier_approvers holds the people — but
// nothing here asks the caller to think about it. Building a chain step by step
// through separate endpoints meant a half-saved chain was a reachable state and
// every keystroke was a round trip.
//
//   GET  ?clientId=&category=&employeeId=   the existing chain, if any
//   POST                                     replace it wholesale
//
// POST is idempotent per target: saving again replaces the same chain rather
// than stacking up new ones, so the form can just save what it shows.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = APPROVAL_CATEGORIES as readonly string[]
const APPROVER_TYPES = [
  'manager', 'any_manager_at', 'finance_role', 'admin', 'self', 'specific_user',
]
const VERDICTS = ['green', 'amber', 'red']

interface ApproverInput {
  approver_type: string
  approver_user_id?: string | null
  min_band_rank?: number | null
  min_verdict?: string
}

interface SaveBody {
  clientId: string
  // null covers everyone at the client (the client default for this
  // category); a uuid covers just that person.
  employeeId: string | null
  category: string
  mode: 'sequential' | 'parallel'
  quorum: 'any' | 'all'
  approvers: ApproverInput[]
}

async function authorise(
  userId: string,
  clientId: string
): Promise<{ ok: true; tmcId: string } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(db, userId, 'manage_approvals', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const client = await clients.tenancy(db, clientId)

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Client not found for this TMC', status: 404 }
  }

  return { ok: true, tmcId: auth.tmcId }
}

// Which chain currently covers this target, if one does. Only ever returns a
// client-owned chain: a shared template reached through the assign flow is not
// this flow's to overwrite.
async function findExistingChain(
  clientId: string,
  employeeId: string | null,
  category: string
): Promise<string | null> {
  const templateId = employeeId
    ? await approvals.employeeTemplateId(db, employeeId, category)
    : await approvals.defaultTemplateId(db, clientId, category)

  if (!templateId) return null

  const template = await approvals.ownership(db, templateId)

  return template?.client_id === clientId ? template.id : null
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  const category = req.nextUrl.searchParams.get('category') ?? 'air'
  const employeeId = req.nextUrl.searchParams.get('employeeId') || null

  if (!clientId) {
    return Response.json({ error: 'clientId is required' }, { status: 400 })
  }

  const access = await authorise(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const templateId = await findExistingChain(clientId, employeeId, category)

  if (!templateId) {
    return Response.json({ ok: true, chain: null })
  }

  const [template, bindings] = await Promise.all([
    approvals.template(db, templateId),
    approvals.bindings(db, clientId, templateId),
  ])

  const byTier = new Map(bindings.map(b => [b.tier, b]))

  // Flattened back into the one list the form works in — the caller never sees
  // the two halves separately.
  const steps = template?.tiers ?? []
  const approvers = [...steps]
    .sort((a, b) => a.tier - b.tier)
    .map(step => {
      const bound = byTier.get(step.tier)
      return {
        approver_type: bound?.approver_type ?? '',
        approver_user_id: bound?.approver_user_id ?? null,
        min_band_rank: bound?.min_band_rank ?? null,
        min_verdict: step.min_verdict,
      }
    })

  return Response.json({
    ok: true,
    chain: { id: templateId, mode: template?.mode, quorum: template?.quorum, approvers },
  })
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: SaveBody = await req.json()
  const { clientId, employeeId, category, mode, quorum, approvers } = body

  if (!clientId || !CATEGORIES.includes(category)) {
    return Response.json({ error: 'clientId and a valid category are required' }, { status: 400 })
  }
  if (mode !== 'sequential' && mode !== 'parallel') {
    return Response.json({ error: `Invalid mode: ${mode}` }, { status: 400 })
  }
  if (!Array.isArray(approvers) || approvers.length === 0) {
    return Response.json({ error: 'Add at least one approver' }, { status: 400 })
  }
  if (mode === 'parallel' && approvers.length < 2) {
    return Response.json(
      { error: 'Multiple approvers needs at least two — use multi-tier for a single approver' },
      { status: 400 }
    )
  }

  for (const [i, a] of approvers.entries()) {
    if (!APPROVER_TYPES.includes(a.approver_type)) {
      return Response.json({ error: `Approver ${i + 1}: choose who approves` }, { status: 400 })
    }
    if (a.approver_type === 'specific_user' && !a.approver_user_id) {
      return Response.json({ error: `Approver ${i + 1}: choose a person` }, { status: 400 })
    }
    if (a.approver_type === 'any_manager_at' && (a.min_band_rank === undefined || a.min_band_rank === null)) {
      return Response.json({ error: `Approver ${i + 1}: choose a minimum band rank` }, { status: 400 })
    }
    if (a.min_verdict && !VERDICTS.includes(a.min_verdict)) {
      return Response.json({ error: `Approver ${i + 1}: invalid trigger` }, { status: 400 })
    }
  }

  const access = await authorise(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  if (employeeId) {
    const [atClient] = await employees.idsInClientAmong(db, clientId, [employeeId])

    if (!atClient) {
      return Response.json({ error: 'Employee not found at this client' }, { status: 404 })
    }
  }

  const assignedBy = (await employees.traveller(db, user.id))?.id ?? null

  // Steps are numbered 1..n in BOTH modes. Bindings are keyed by step number
  // and mergeTiers looks them up that way, so duplicates would collapse several
  // approvers onto one binding — and the binding primary key forbids them
  // anyway.
  //
  // Parallel-ness is not expressed in the numbering: raiseApprovals collapses
  // every triggered step onto the lowest number when it writes the approvals
  // rows, which is what makes quorum able to find siblings by
  // (booking_id, tier).
  const tiers = approvers.map((a, i) => ({
    tier: i + 1,
    min_verdict: a.min_verdict ?? 'amber',
    label: null,
  }))

  const existingId = await findExistingChain(clientId, employeeId, category)

  // Naming reads happen outside the transaction: they are pure lookups, only
  // needed when a chain is being created, and keeping them out means the
  // transaction below holds its connection for writes alone.
  let name = ''
  if (!existingId) {
    const [client, who] = await Promise.all([
      clients.clientName(db, clientId),
      employeeId ? employees.fullName(db, employeeId) : Promise.resolve(null),
    ])

    // Never shown — client-owned chains are excluded from the template list —
    // but names are unique per TMC, so the id fragment keeps two people with
    // the same name at the same client from colliding.
    const suffix = employeeId ? ` [${employeeId.slice(0, 8)}]` : ''
    name = `${client?.name ?? 'Client'} — ${who ?? 'All employees'} — ${category}${suffix}`
  }

  // ── The chain, its approvers and the pointer at it, atomically ───────────
  // THE FAILURE THIS PREVENTS: the approver bindings are replaced wholesale as
  // DELETE-then-INSERT. If the insert failed — and the client-check trigger
  // says it realistically can, when someone named does not work at this
  // client — the chain was left with NO approvers while the pointer below
  // still routed bookings to it. Every booking down that chain then resolves
  // to no approver at all and lands in approval_misconfigured, for a request
  // that returned 400 and looked like it had changed nothing.
  let chainId: string
  try {
    chainId = await transaction(async (tx) => {
      const templateId = existingId
        ? (await approvals.updateTemplate(tx, existingId, { mode, quorum, tiers, updated_by: assignedBy })).id
        : (await approvals.insertTemplate(tx, {
            tmc_id: access.tmcId,
            client_id: clientId,
            name,
            code: null,
            description: null,
            mode,
            quorum,
            tiers,
            updated_by: assignedBy,
          })).id

      // Replace the bindings wholesale rather than diffing. The step numbering
      // shifts whenever an approver is removed or the mode flips, so matching
      // old rows to new positions would be guesswork.
      await approvals.replaceBindings(tx, clientId, templateId, approvers.map((a, i) => ({
        tier: i + 1,
        approver_type: a.approver_type,
        approver_user_id: a.approver_type === 'specific_user' ? a.approver_user_id ?? null : null,
        min_band_rank: a.approver_type === 'any_manager_at' ? a.min_band_rank ?? null : null,
        assigned_by: assignedBy,
      })))

      // Point the target at this chain.
      if (employeeId) {
        await approvals.assignToEmployees(tx, [employeeId], category, templateId, assignedBy)
      } else {
        await approvals.assignDefault(tx, clientId, category, templateId, assignedBy)
      }

      return templateId
    }, { tenantId: access.tmcId, userId: user.id })
  } catch (err) {
    if (isConstraint(err, 'check')) {
      return Response.json(
        { error: 'One of those people does not work at this client' },
        { status: 400 }
      )
    }
    throw err
  }

  return Response.json({ ok: true, chainId })
})
