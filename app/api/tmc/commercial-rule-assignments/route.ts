import { createClient } from '@/utils/supabase/server'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { NextRequest } from 'next/server'
import { db, type Queryable } from '@/app/lib/db'
import * as commercials from '@/app/lib/repositories/commercials'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

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

// Whether each kind's id exists at the caller's TMC. Without this a target id
// from another tenant would satisfy the foreign key perfectly well and quietly
// attach their client set to this rule.
const TARGET_EXISTS: Record<TargetKind, (db: Queryable, id: string, tmcId: string) => Promise<boolean>> = {
  client: async (db, id, tmcId) => (await clients.statusInTmc(db, id, tmcId)) !== null,
  client_group: async (db, id, tmcId) => (await clients.groupInTmc(db, id, tmcId)) !== null,
  bucket: async (db, id, tmcId) => (await clients.bucketInTmc(db, id, tmcId)) !== null,
}

interface AssignBody {
  ruleId?: string
  targets?: { kind?: string; id?: string }[]
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const ruleId = req.nextUrl.searchParams.get('ruleId')

  return Response.json({ ok: true, assignments: await commercials.assignmentList(db, auth.tmcId, ruleId) })
})

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  const body: AssignBody = await req.json()

  if (!body.ruleId || !Array.isArray(body.targets) || body.targets.length === 0) {
    return Response.json({ error: 'ruleId and at least one target are required' }, { status: 400 })
  }
  const ruleId = body.ruleId

  // The rule must belong to this TMC.
  if (!(await commercials.rule(db, ruleId, tmcId))) {
    return Response.json({ error: 'Rule not found' }, { status: 404 })
  }

  const rows: commercials.NewAssignment[] = []

  for (const target of body.targets) {
    const kind = target.kind as TargetKind
    if (!kind || !(kind in TARGET_EXISTS)) {
      return Response.json({ error: `Unknown target kind: ${target.kind}` }, { status: 400 })
    }
    if (!target.id) {
      return Response.json({ error: 'Every target needs an id' }, { status: 400 })
    }

    if (!(await TARGET_EXISTS[kind](db, target.id, tmcId))) {
      return Response.json({ error: `That ${kind.replace('_', ' ')} was not found for this TMC` }, { status: 422 })
    }

    rows.push({
      rule_id: ruleId,
      kind,
      client_id: kind === 'client' ? target.id : null,
      client_group_id: kind === 'client_group' ? target.id : null,
      bucket_id: kind === 'bucket' ? target.id : null,
    })
  }

  // Assigning the same target twice is a no-op rather than a 409 — the three
  // partial unique indexes are what make that safe.
  const assigned = await commercials.assign(db, tmcId, user.id, rows)

  return Response.json({ ok: true, assigned })
})

export const DELETE = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_commercials')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 })
  }

  await commercials.unassign(db, id, auth.tmcId)

  return Response.json({ ok: true })
})
