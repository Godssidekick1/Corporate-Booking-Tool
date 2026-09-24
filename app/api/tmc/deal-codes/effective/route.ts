import { createClient } from '@/utils/supabase/server'
import * as dealCodes from '@/app/lib/repositories/dealCodes'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'
import {
  resolveDealCodes,
  describeVia,
  type ResolvableAssignment,
} from '@/app/lib/deal-codes/resolveDealCodes'
import { parsePageParams, paginateInMemory } from '@/app/lib/pagination'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'

// ── GET /api/tmc/deal-codes/effective ────────────────────────────────────────
// Coverage: which code actually applies, for every client, and why.
//
// Distinct from the deal-codes master beside it. The master is one row per deal
// the TMC has negotiated, whether or not anyone receives it. This is one row per
// client per airline per type, containing only the winner — the outcome of
// resolution rather than the definitions that fed it.
//
// WHY IT RESOLVES EVERYTHING BEFORE PAGING
// Search has to span the whole result set, and a row's searchable text (client
// name, bucket name, group name) is only known after resolution. Filtering a
// page of already-resolved rows would silently hide matches on page four.
//
// The query count does NOT grow with clients: a fixed handful of queries, then
// resolveDealCodes runs in memory per client. That holds comfortably into the
// low thousands of clients. Beyond that this wants a materialised table — worth
// knowing before it bites, not worth building now.
// ─────────────────────────────────────────────────────────────────────────────

interface CoverageRow {
  clientId: string
  clientName: string
  airline: string
  codeType: string
  code: string
  via: string
  ambiguous: boolean
  beat: { code: string; via: string }[]
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_deal_codes')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  const params = parsePageParams(req.nextUrl.searchParams)
  // Optional: narrow to one client. The screen no longer requires it, but the
  // client detail page reuses this endpoint for its own section.
  const onlyClientId = req.nextUrl.searchParams.get('clientId')

  const accessibleIds = await getAccessibleClientIds(db, user.id, auth.role ?? '')
  if (accessibleIds !== null && accessibleIds.length === 0) {
    return Response.json(paginateInMemory([], params))
  }

  const [clientRows, assignmentRows] = await Promise.all([
    clients.coverageClients(db, tmcId, accessibleIds, onlyClientId),
    dealCodes.assignmentsForTmc(db, tmcId),
  ])

  if (clientRows.length === 0 || assignmentRows.length === 0) {
    return Response.json(paginateInMemory([], params))
  }

  const dealIds = [...new Set(assignmentRows.map(a => a.deal_code_id))]
  const bucketIds = [...new Set(assignmentRows.map(a => a.bucket_id).filter((b): b is string => Boolean(b)))]

  // Memberships for the listed clients only -- this used to read every
  // tenant's bucket_clients rows to use a handful of them.
  const [deals, buckets, groupName, memberships] = await Promise.all([
    dealCodes.forResolution(db, dealIds),
    clients.bucketLabels(db, bucketIds),
    clients.groupNamesForTmc(db, tmcId),
    clients.memberships(db, clientRows.map(c => c.id)),
  ])

  // Which buckets each client sits in, built once rather than per client.
  const bucketsByClient = new Map<string, string[]>()
  for (const m of memberships) {
    const list = bucketsByClient.get(m.client_id)
    if (list) list.push(m.bucket_id)
    else bucketsByClient.set(m.client_id, [m.bucket_id])
  }

  const rows: CoverageRow[] = []

  for (const client of clientRows) {
    const clientBuckets = bucketsByClient.get(client.id) ?? []

    const reaching = assignmentRows.filter(a => {
      if (a.kind === 'client') return a.client_id === client.id
      if (a.kind === 'bucket') return a.bucket_id !== null && clientBuckets.includes(a.bucket_id)
      return a.client_group_id !== null && a.client_group_id === client.client_group_id
    })

    if (reaching.length === 0) continue

    const assignments: ResolvableAssignment[] = reaching.map(a => ({
      deal_code_id: a.deal_code_id,
      kind: a.kind,
      via_name:
        a.kind === 'bucket'
          ? buckets.get(a.bucket_id!)?.name ?? null
          : a.kind === 'client_group'
            ? groupName.get(a.client_group_id!) ?? null
            : null,
    }))

    for (const r of resolveDealCodes({ deals, assignments })) {
      rows.push({
        clientId: client.id,
        clientName: client.name,
        airline: r.airline,
        codeType: r.codeType,
        code: r.code,
        via: describeVia(r.kind, r.viaName),
        ambiguous: r.ambiguous,
        beat: r.beat.map(b => ({ code: b.code, via: describeVia(b.kind, b.viaName) })),
      })
    }
  }

  // Matched against the client, the code, and the route it arrived by — which
  // is how searching a bucket or a group name finds everything it hands out.
  // `via` already reads "Bucket · Star Alliance FY26", so one field covers both.
  const search = params.search.toLowerCase()
  const filtered = search
    ? rows.filter(r =>
        r.clientName.toLowerCase().includes(search) ||
        r.code.toLowerCase().includes(search) ||
        r.via.toLowerCase().includes(search) ||
        r.airline.toLowerCase().includes(search)
      )
    : rows

  return Response.json(paginateInMemory(filtered, params))
})
