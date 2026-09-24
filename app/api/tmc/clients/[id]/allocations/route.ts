import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import * as fop from '@/app/lib/repositories/fop'
import { route } from '@/app/lib/http/handler'

// ── GET /api/tmc/clients/[id]/allocations ────────────────────────────────────
// Every deal code and form of payment that REACHES this client, and how.
//
// Three ways something reaches a client: assigned to the client directly,
// assigned to a bucket the client is in, or assigned to the client's group.
// Corporate Settings has to show all three or it is lying about what applies —
// but it must also say which, because removing an inherited one edits a bucket
// that governs other clients too.
//
// ONE ENDPOINT RATHER THAN FILTERS ON THE TWO LIST ROUTES. The ranking has to
// happen somewhere, and doing it in the browser means the screen can disagree
// with the booking engine about which deal code wins. This reuses the very same
// KIND_RANK the resolvers sort by, so it cannot.
// ─────────────────────────────────────────────────────────────────────────────

type Kind = 'client' | 'bucket' | 'client_group'

// Explicitness of intent, lowest first. Imported in spirit from
// resolveDealCodes/resolveFop — the same ladder, stated once here because this
// route ranks assignment rows rather than resolved candidates.
const KIND_RANK: Record<Kind, number> = { client: 0, bucket: 1, client_group: 2 }

interface AllocationRow {
  assignmentId: string
  id: string
  code: string | null
  label: string
  source: Kind
  sourceId: string | null
  sourceName: string | null
  // Only forms of payment carry this; a suspended mapping still reaches the
  // client on paper and hiding it would make the screen disagree with the master.
  isActive?: boolean
}

interface AssignmentRow {
  id: string
  kind: string
  client_id: string | null
  client_group_id: string | null
  bucket_id: string | null
  is_active?: boolean
}

export const GET = route(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const check = await requireTmcPermission(db, user.id, 'manage_clients', id)
  if (!check.authorized || !check.tmcId) {
    return Response.json({ error: check.error ?? 'Forbidden' }, { status: check.status ?? 403 })
  }
  const tmcId = check.tmcId

  const client = await clients.reachProfile(db, id, tmcId)

  if (!client) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  const [bucketIds, dealRows, fopRows] = await Promise.all([
    clients.bucketIdsOfClient(db, id),
    dealCodes.assignmentsForTmc(db, tmcId),
    fop.assignmentsForTmc(db, tmcId),
  ])

  // Does this assignment row reach this client at all?
  function reaches(a: AssignmentRow): boolean {
    if (a.kind === 'client') return a.client_id === id
    if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
    return a.client_group_id !== null && a.client_group_id === client!.client_group_id
  }

  const deals = dealRows.filter(reaches)
  const fops = fopRows.filter(reaches)

  // Names only for the routes that actually reached — no point fetching every
  // bucket in the TMC to label two of them.
  const usedBuckets = [...new Set([...deals, ...fops].map(a => a.bucket_id).filter((b): b is string => Boolean(b)))]
  const dealCodeIds = [...new Set(deals.map(a => a.deal_code_id))]
  const fopIds = [...new Set(fops.map(a => a.fop_id))]

  const [bucketById, groupName, dealLabels, fopLabels, bucketSizeMap] = await Promise.all([
    clients.bucketLabels(db, usedBuckets),
    clients.groupNames(db, client.client_group_id ? [client.client_group_id] : []),
    dealCodes.labels(db, dealCodeIds),
    fop.labels(db, fopIds),
    // How many clients each bucket governs, so the confirm dialog before
    // removing an inherited mapping can say what else it affects.
    clients.memberCounts(db, usedBuckets),
  ])

  const dealById = new Map(dealLabels.map(d => [d.id, d]))
  const fopById = new Map(fopLabels.map(f => [f.id, f]))

  function source(a: AssignmentRow): { sourceId: string | null; sourceName: string | null } {
    if (a.kind === 'bucket') {
      const bucket = a.bucket_id ? bucketById.get(a.bucket_id) : null
      return { sourceId: a.bucket_id, sourceName: bucket?.name ?? null }
    }
    if (a.kind === 'client_group') {
      return { sourceId: a.client_group_id, sourceName: a.client_group_id ? groupName.get(a.client_group_id) ?? null : null }
    }
    return { sourceId: null, sourceName: null }
  }

  const byRank = (a: AllocationRow, b: AllocationRow) =>
    KIND_RANK[a.source] - KIND_RANK[b.source] || (a.code ?? '').localeCompare(b.code ?? '')

  const dealAllocations: AllocationRow[] = deals
    .map((a): AllocationRow | null => {
      const deal = dealById.get(a.deal_code_id)
      if (!deal) return null
      return {
        assignmentId: a.id,
        id: deal.id,
        code: deal.code,
        label: [deal.airline_code, deal.code_type].filter(Boolean).join(' · '),
        source: a.kind as Kind,
        ...source(a),
      }
    })
    .filter((r): r is AllocationRow => r !== null)
    .sort(byRank)

  const fopAllocations: AllocationRow[] = fops
    .map((a): AllocationRow | null => {
      const form = fopById.get(a.fop_id)
      if (!form) return null
      return {
        assignmentId: a.id,
        id: form.id,
        code: form.fop_code,
        label: [form.label, form.payer, form.fop_type].filter(Boolean).join(' · '),
        source: a.kind as Kind,
        isActive: a.is_active !== false,
        ...source(a),
      }
    })
    .filter((r): r is AllocationRow => r !== null)
    .sort(byRank)

  return Response.json({
    ok: true,
    dealCodes: dealAllocations,
    formsOfPayment: fopAllocations,
    bucketSizes: Object.fromEntries(bucketSizeMap),
  })
})
