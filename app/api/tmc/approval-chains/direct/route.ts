import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { APPROVAL_CATEGORIES } from '@/app/lib/approval-engine/resolveApprovalTier'
import { withTransaction, orAbort } from '@/app/lib/db/tx'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'

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
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  clientId: string
): Promise<{ ok: true; tmcId: string } | { ok: false; error: string; status: number }> {
  const auth = await requireTmcPermission(db, userId, 'manage_approvals', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return { ok: false, error: auth.error ?? 'Forbidden', status: auth.status ?? 403 }
  }

  const { data: client } = await service
    .from('clients')
    .select('id, tmc_id')
    .eq('id', clientId)
    .maybeSingle()

  if (!client || client.tmc_id !== auth.tmcId) {
    return { ok: false, error: 'Client not found for this TMC', status: 404 }
  }

  return { ok: true, tmcId: auth.tmcId }
}

// Which chain currently covers this target, if one does. Only ever returns a
// client-owned chain: a shared template reached through the assign flow is not
// this flow's to overwrite.
async function findExistingChain(
  service: ReturnType<typeof createServiceClient>,
  clientId: string,
  employeeId: string | null,
  category: string
): Promise<string | null> {
  const templateId = employeeId
    ? (await service
        .from('employee_approval_templates')
        .select('template_id')
        .eq('employee_id', employeeId)
        .eq('category', category)
        .maybeSingle()).data?.template_id
    : (await service
        .from('client_default_approval_templates')
        .select('template_id')
        .eq('client_id', clientId)
        .eq('category', category)
        .maybeSingle()).data?.template_id

  if (!templateId) return null

  const { data: template } = await service
    .from('approval_chain_templates')
    .select('id, client_id')
    .eq('id', templateId)
    .maybeSingle()

  return template?.client_id === clientId ? template.id : null
}

export async function GET(req: NextRequest) {
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

  const service = createServiceClient()
  const access = await authorise(service, user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const templateId = await findExistingChain(service, clientId, employeeId, category)

  if (!templateId) {
    return Response.json({ ok: true, chain: null })
  }

  const { data: template } = await service
    .from('approval_chain_templates')
    .select('id, mode, quorum, tiers')
    .eq('id', templateId)
    .single()

  const { data: bindings } = await service
    .from('approval_tier_approvers')
    .select('tier, approver_type, approver_user_id, min_band_rank')
    .eq('client_id', clientId)
    .eq('template_id', templateId)

  const byTier = new Map((bindings ?? []).map(b => [b.tier, b]))

  // Flattened back into the one list the form works in — the caller never sees
  // the two halves separately.
  const steps = (template?.tiers as { tier: number; min_verdict: string }[] | null) ?? []
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
}

export async function POST(req: NextRequest) {
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

  const service = createServiceClient()
  const access = await authorise(service, user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  if (employeeId) {
    const { data: employee } = await service
      .from('employees')
      .select('id')
      .eq('id', employeeId)
      .eq('client_id', clientId)
      .maybeSingle()

    if (!employee) {
      return Response.json({ error: 'Employee not found at this client' }, { status: 404 })
    }
  }

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

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

  const existingId = await findExistingChain(service, clientId, employeeId, category)

  // Naming reads happen outside the transaction: they are pure lookups, only
  // needed when a chain is being created, and keeping them out means the
  // transaction below holds its connection for writes alone.
  let name = ''
  if (!existingId) {
    const [{ data: client }, { data: employee }] = await Promise.all([
      service.from('clients').select('name').eq('id', clientId).single(),
      employeeId
        ? service.from('employees').select('full_name').eq('id', employeeId).single()
        : Promise.resolve({ data: null }),
    ])

    // Never shown — client-owned chains are excluded from the template list —
    // but names are unique per TMC, so the id fragment keeps two people with
    // the same name at the same client from colliding.
    const who = employee?.full_name ?? 'All employees'
    const suffix = employeeId ? ` [${employeeId.slice(0, 8)}]` : ''
    name = `${client?.name ?? 'Client'} — ${who} — ${category}${suffix}`
  }

  // ── The chain, its approvers and the pointer at it, atomically ───────────
  // THE FAILURE THIS PREVENTS: the approver bindings are replaced wholesale as
  // DELETE-then-INSERT. If the insert failed — and 23514 says it realistically
  // can, when someone named does not work at this client — the chain was left
  // with NO approvers while the pointer below still routed bookings to it.
  // Every booking down that chain then resolves to no approver at all and
  // lands in approval_misconfigured, for a request that returned 400 and
  // looked like it had changed nothing.
  const { data: chainId, error: writeError } = await withTransaction(async (tx) => {
    let templateId = existingId

    if (templateId) {
      await orAbort(
        tx.from('approval_chain_templates')
          .update({ mode, quorum, tiers, updated_by: caller?.id ?? null })
          .eq('id', templateId)
      )
    } else {
      const created = await orAbort(
        tx.from<{ id: string }[]>('approval_chain_templates')
          .insert({
            tmc_id: access.tmcId,
            client_id: clientId,
            name,
            mode,
            quorum,
            tiers,
            updated_by: caller?.id ?? null,
          })
          .select('id')
          .single()
      )
      templateId = created.id
    }

    // Replace the bindings wholesale rather than diffing. The step numbering
    // shifts whenever an approver is removed or the mode flips, so matching
    // old rows to new positions would be guesswork.
    await orAbort(
      tx.from('approval_tier_approvers')
        .delete()
        .eq('client_id', clientId)
        .eq('template_id', templateId)
    )

    await orAbort(
      tx.from('approval_tier_approvers')
        .insert(approvers.map((a, i) => ({
          client_id: clientId,
          template_id: templateId,
          tier: i + 1,
          approver_type: a.approver_type,
          approver_user_id: a.approver_type === 'specific_user' ? a.approver_user_id : null,
          min_band_rank: a.approver_type === 'any_manager_at' ? a.min_band_rank : null,
          assigned_by: caller?.id ?? null,
        })))
    )

    // Point the target at this chain.
    if (employeeId) {
      await orAbort(
        tx.from('employee_approval_templates').upsert({
          employee_id: employeeId,
          category,
          template_id: templateId,
          assigned_by: caller?.id ?? null,
          assigned_at: new Date().toISOString(),
        }, { onConflict: 'employee_id,category' })
      )
    } else {
      await orAbort(
        tx.from('client_default_approval_templates').upsert({
          client_id: clientId,
          category,
          template_id: templateId,
          assigned_by: caller?.id ?? null,
          assigned_at: new Date().toISOString(),
        }, { onConflict: 'client_id,category' })
      )
    }

    return templateId
  })

  if (writeError) {
    if (writeError.code === '23514') {
      return Response.json(
        { error: 'One of those people does not work at this client' },
        { status: 400 }
      )
    }
    return Response.json({ error: writeError.message }, { status: 500 })
  }

  return Response.json({ ok: true, chainId })
}
