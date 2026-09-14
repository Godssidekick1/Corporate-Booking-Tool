import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'

// ── /api/tmc/commercial-rule-assignments ─────────────────────────────────────
// Who a markup, discount or processing fee reaches.
//
// Mirrors /api/tmc/deal-code-assignments deliberately, down to the `targets`
// array on POST: a TC assigning one rule to twelve clients should be one action,
// not twelve. The three assignment kinds are the same ladder every other master
// uses — client, bucket, client_group — so a desk that has learned one has
// learned all of them.
// ─────────────────────────────────────────────────────────────────────────────

type TargetKind = 'client' | 'client_group' | 'bucket'

// Which table each kind's id must exist in, scoped to the caller's TMC. Without
// this a target id from another tenant would satisfy the foreign key perfectly
// well and quietly attach their client set to this rule.
const TARGET_TABLE: Record<TargetKind, string> = {
  client: 'clients',
  client_group: 'client_groups',
  bucket: 'buckets',
}

// Which column on commercial_rule_assignments holds it.
const TARGET_COLUMN: Record<TargetKind, string> = {
  client: 'client_id',
  client_group: 'client_group_id',
  bucket: 'bucket_id',
}

interface AssignBody {
  ruleId?: string
  targets?: { kind?: string; id?: string }[]
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const ruleId = req.nextUrl.searchParams.get('ruleId')

  let query = service
    .from('commercial_rule_assignments')
    .select('id, rule_id, kind, client_id, client_group_id, bucket_id, created_at')
    .eq('tmc_id', auth.tmcId)

  if (ruleId) query = query.eq('rule_id', ruleId)

  const { data, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, assignments: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  const body: AssignBody = await req.json()

  if (!body.ruleId || !Array.isArray(body.targets) || body.targets.length === 0) {
    return Response.json({ error: 'ruleId and at least one target are required' }, { status: 400 })
  }

  // The rule must belong to this TMC.
  const { data: rule } = await service
    .from('commercial_rules')
    .select('id')
    .eq('id', body.ruleId)
    .eq('tmc_id', tmcId)
    .maybeSingle()

  if (!rule) {
    return Response.json({ error: 'Rule not found' }, { status: 404 })
  }

  const rows: Record<string, unknown>[] = []

  for (const target of body.targets) {
    const kind = target.kind as TargetKind
    if (!kind || !(kind in TARGET_TABLE)) {
      return Response.json({ error: `Unknown target kind: ${target.kind}` }, { status: 400 })
    }
    if (!target.id) {
      return Response.json({ error: 'Every target needs an id' }, { status: 400 })
    }

    const { data: exists } = await service
      .from(TARGET_TABLE[kind])
      .select('id')
      .eq('id', target.id)
      .eq('tmc_id', tmcId)
      .maybeSingle()

    if (!exists) {
      return Response.json({ error: `That ${kind.replace('_', ' ')} was not found for this TMC` }, { status: 422 })
    }

    rows.push({
      tmc_id: tmcId,
      rule_id: body.ruleId,
      kind,
      [TARGET_COLUMN[kind]]: target.id,
      created_by: user.id,
    })
  }

  // ignoreDuplicates so assigning the same target twice is a no-op rather than a
  // 409 — the three partial unique indexes are what make that safe.
  const { data: inserted, error } = await service
    .from('commercial_rule_assignments')
    .upsert(rows, { ignoreDuplicates: true })
    .select('id')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, assigned: inserted?.length ?? 0 })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 })
  }

  const { error } = await service
    .from('commercial_rule_assignments')
    .delete()
    .eq('id', id)
    .eq('tmc_id', auth.tmcId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
