import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import {
  resolveDealCodes,
  describeVia,
  type ResolvableAssignment,
} from '@/app/lib/deal-codes/resolveDealCodes'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/deal-codes/effective?clientId= ──────────────────────────────
// What one client actually resolves to, and why.
//
// This is the view the screen being replaced has no answer for. Overlap is
// normal, so the interesting part is not the list of winners but the "via" and
// "beat" columns beside them: an admin who expected a different code can see
// which rule took it away instead of guessing.
//
// The gathering below is the ONLY part specific to the database. The ranking
// lives in resolveDealCodes, which the booking path calls with the same inputs
// plus an itinerary — so this screen and a real booking can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) {
    return Response.json({ error: 'clientId is required' }, { status: 400 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_deal_codes', clientId)
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const { data: client } = await service
    .from('clients')
    .select('id, name, client_group_id')
    .eq('id', clientId)
    .eq('tmc_id', auth.tmcId)
    .maybeSingle()

  if (!client) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  // The three routes a deal can reach this client by.
  const { data: bucketRows } = await service
    .from('bucket_clients')
    .select('bucket_id')
    .eq('client_id', clientId)

  const bucketIds = (bucketRows ?? []).map(b => b.bucket_id)

  const { data: assignmentRows } = await service
    .from('deal_code_assignments')
    .select('deal_code_id, kind, client_id, client_group_id, bucket_id')
    .eq('tmc_id', auth.tmcId)

  const reaching = (assignmentRows ?? []).filter(a => {
    if (a.kind === 'client') return a.client_id === clientId
    if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
    return a.client_group_id !== null && a.client_group_id === client.client_group_id
  })

  if (reaching.length === 0) {
    return Response.json({ ok: true, client, effective: [] })
  }

  const dealIds = [...new Set(reaching.map(a => a.deal_code_id))]

  const [{ data: deals }, { data: buckets }, { data: groups }] = await Promise.all([
    service
      .from('deal_codes')
      .select(
        'id, code, code_type, airline_code, flight_spec, active, sales_from, sales_to, travel_from, travel_to, created_at'
      )
      .in('id', dealIds),
    bucketIds.length
      ? service.from('buckets').select('id, name').in('id', bucketIds)
      : Promise.resolve({ data: [] }),
    client.client_group_id
      ? service.from('client_groups').select('id, name').eq('id', client.client_group_id)
      : Promise.resolve({ data: [] }),
  ])

  const bucketName = new Map((buckets ?? []).map(b => [b.id, b.name]))
  const groupName = new Map((groups ?? []).map(g => [g.id, g.name]))

  const assignments: ResolvableAssignment[] = reaching.map(a => ({
    deal_code_id: a.deal_code_id,
    kind: a.kind,
    via_name:
      a.kind === 'bucket'
        ? bucketName.get(a.bucket_id!) ?? null
        : a.kind === 'client_group'
          ? groupName.get(a.client_group_id!) ?? null
          : null,
  }))

  // No airline or flight passed: this answers "everything this client could
  // get", not "what applies to one itinerary". Sales and travel windows are
  // still enforced, so an expired deal does not appear as effective.
  const effective = resolveDealCodes({ deals: deals ?? [], assignments })

  return Response.json({
    ok: true,
    client,
    effective: effective.map(e => ({
      ...e,
      via: describeVia(e.kind, e.viaName),
      beat: e.beat.map(b => ({ ...b, via: describeVia(b.kind, b.viaName) })),
    })),
  })
}
