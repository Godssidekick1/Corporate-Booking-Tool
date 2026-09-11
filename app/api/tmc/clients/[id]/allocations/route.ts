import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

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
  code: string
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
  kind: Kind
  client_id: string | null
  client_group_id: string | null
  bucket_id: string | null
  is_active?: boolean
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const check = await requireTmcPermission(service, user.id, 'manage_clients', id)
  if (!check.authorized || !check.tmcId) {
    return Response.json({ error: check.error ?? 'Forbidden' }, { status: check.status ?? 403 })
  }
  const tmcId = check.tmcId

  const { data: client } = await service
    .from('clients')
    .select('id, client_group_id')
    .eq('id', id)
    .eq('tmc_id', tmcId)
    .maybeSingle()

  if (!client) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  const { data: memberRows } = await service
    .from('bucket_clients')
    .select('bucket_id')
    .eq('client_id', id)

  const bucketIds = (memberRows ?? []).map(r => r.bucket_id)

  const [{ data: dealRows }, { data: fopRows }] = await Promise.all([
    service
      .from('deal_code_assignments')
      .select('id, deal_code_id, kind, client_id, client_group_id, bucket_id')
      .eq('tmc_id', tmcId),
    service
      .from('fop_assignments')
      .select('id, fop_id, kind, client_id, client_group_id, bucket_id, is_active')
      .eq('tmc_id', tmcId),
  ])

  // Does this assignment row reach this client at all?
  function reaches(a: AssignmentRow): boolean {
    if (a.kind === 'client') return a.client_id === id
    if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
    return a.client_group_id !== null && a.client_group_id === client!.client_group_id
  }

  const deals = (dealRows ?? []).filter(reaches)
  const fops = (fopRows ?? []).filter(reaches)

  // Names only for the routes that actually reached — no point fetching every
  // bucket in the TMC to label two of them.
  const usedBuckets = [...new Set([...deals, ...fops].map(a => a.bucket_id).filter(Boolean) as string[])]
  const dealCodeIds = [...new Set(deals.map(a => a.deal_code_id))]
  const fopIds = [...new Set(fops.map(a => a.fop_id))]

  const [{ data: buckets }, { data: groups }, { data: dealCodes }, { data: forms }] = await Promise.all([
    usedBuckets.length
      ? service.from('buckets').select('id, name, code').in('id', usedBuckets)
      : Promise.resolve({ data: [] as { id: string; name: string; code: string | null }[] }),
    client.client_group_id
      ? service.from('client_groups').select('id, name').eq('id', client.client_group_id)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    dealCodeIds.length
      ? service.from('deal_codes').select('id, code, code_type, airline_code').in('id', dealCodeIds)
      : Promise.resolve({ data: [] as { id: string; code: string; code_type: string; airline_code: string | null }[] }),
    fopIds.length
      ? service.from('forms_of_payment').select('id, fop_code, label, payer, fop_type').in('id', fopIds)
      : Promise.resolve({ data: [] as { id: string; fop_code: string; label: string; payer: string; fop_type: string }[] }),
  ])

  const bucketById = new Map((buckets ?? []).map(b => [b.id, b]))
  const groupById = new Map((groups ?? []).map(g => [g.id, g]))
  const dealById = new Map((dealCodes ?? []).map(d => [d.id, d]))
  const fopById = new Map((forms ?? []).map(f => [f.id, f]))

  function source(a: AssignmentRow): { sourceId: string | null; sourceName: string | null } {
    if (a.kind === 'bucket') {
      const bucket = a.bucket_id ? bucketById.get(a.bucket_id) : null
      return { sourceId: a.bucket_id, sourceName: bucket?.name ?? null }
    }
    if (a.kind === 'client_group') {
      const group = a.client_group_id ? groupById.get(a.client_group_id) : null
      return { sourceId: a.client_group_id, sourceName: group?.name ?? null }
    }
    return { sourceId: null, sourceName: null }
  }

  const byRank = (a: AllocationRow, b: AllocationRow) =>
    KIND_RANK[a.source] - KIND_RANK[b.source] || a.code.localeCompare(b.code)

  const dealAllocations: AllocationRow[] = deals
    .map((a): AllocationRow | null => {
      const deal = dealById.get(a.deal_code_id)
      if (!deal) return null
      return {
        assignmentId: a.id,
        id: deal.id,
        code: deal.code,
        label: [deal.airline_code, deal.code_type].filter(Boolean).join(' · '),
        source: a.kind,
        ...source(a),
      }
    })
    .filter((r): r is AllocationRow => r !== null)
    .sort(byRank)

  const fopAllocations: AllocationRow[] = fops
    .map((a): AllocationRow | null => {
      const fop = fopById.get(a.fop_id)
      if (!fop) return null
      return {
        assignmentId: a.id,
        id: fop.id,
        code: fop.fop_code,
        label: [fop.label, fop.payer, fop.fop_type].filter(Boolean).join(' · '),
        source: a.kind,
        isActive: a.is_active !== false,
        ...source(a),
      }
    })
    .filter((r): r is AllocationRow => r !== null)
    .sort(byRank)

  // How many other clients each bucket governs, so the confirm dialog before
  // removing an inherited mapping can say what else it affects.
  const bucketSizes: Record<string, number> = {}
  if (usedBuckets.length) {
    const { data: counts } = await service
      .from('bucket_clients')
      .select('bucket_id, client_id')
      .in('bucket_id', usedBuckets)

    for (const row of counts ?? []) {
      bucketSizes[row.bucket_id] = (bucketSizes[row.bucket_id] ?? 0) + 1
    }
  }

  return Response.json({
    ok: true,
    dealCodes: dealAllocations,
    formsOfPayment: fopAllocations,
    bucketSizes,
  })
}
