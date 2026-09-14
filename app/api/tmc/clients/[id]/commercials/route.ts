import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import {
  resolveCommercials,
  type ResolvableRule,
  type ResolvableAssignment,
  type ResolvedRule,
} from '@/app/lib/commercials/resolveCommercials'
import { KIND_LABELS, type CommercialKind } from '@/app/lib/commercials/calcOnByKind'
import { RULE_COLUMNS } from '@/app/api/tmc/commercial-rules/route'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/clients/[id]/commercials ────────────────────────────────────
// The markup, discount and processing fee in force for ONE client, for
// Corporate Settings.
//
// Shaped like the allocations route next door: it reports what REACHES this
// client, labelled with how — direct, via a bucket, via their client group —
// because removing something inherited is a different act from removing
// something assigned, and the screen has to be able to say so.
//
// Gated on manage_clients rather than manage_commercials, deliberately: this is
// a read on the client's own settings page, and a TC who may open a client may
// see what that client is charged. WRITING a rule still needs
// manage_commercials, on the rules routes.
// ─────────────────────────────────────────────────────────────────────────────

interface EffectiveRule {
  kind: CommercialKind
  label: string
  ruleId: string
  // "2% of BF", "₹250 per sector" — enough to judge without opening the rule.
  summary: string
  via: string
  source: 'client' | 'bucket' | 'client_group'
  sourceName: string | null
  ambiguous: boolean
  // What it lost to nothing, but beat. Surfaced so a desk can see why the rule
  // they expected is not the one in force.
  beat: { ruleId: string; via: string }[]
}

function summarise(resolved: ResolvedRule): string {
  const r = resolved.rule
  const amount = r.calc_type === 'percent' ? `${r.rate}%` : `₹${r.rate}`
  const basis = r.calc_type === 'percent' ? ` of ${r.calc_on.replace(/_/g, '+').toUpperCase()}` : ''
  const per = r.calc_basis === 'per_sector' ? ' per sector' : ''
  const scope = [
    r.airline_code ?? 'all airlines',
    r.cabin ? `cabin ${r.cabin}` : null,
    r.rbd_spec ? `class ${r.rbd_spec}` : null,
  ].filter(Boolean).join(' · ')
  return `${amount}${basis}${per} — ${scope}`
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
    .select('id, client_group_id, markup_active, discount_active, processing_fee_active')
    .eq('id', id)
    .eq('tmc_id', tmcId)
    .maybeSingle()

  if (!client) {
    return Response.json({ error: 'Client not found' }, { status: 404 })
  }

  const [{ data: ruleRows }, { data: memberships }, { data: assignmentRows }] = await Promise.all([
    service.from('commercial_rules').select(RULE_COLUMNS).eq('tmc_id', tmcId),
    service.from('bucket_clients').select('bucket_id').eq('client_id', id),
    service
      .from('commercial_rule_assignments')
      .select('rule_id, kind, client_id, client_group_id, bucket_id')
      .eq('tmc_id', tmcId),
  ])

  const rules = (ruleRows ?? []) as unknown as ResolvableRule[]
  const bucketIds = (memberships ?? []).map(m => m.bucket_id)

  const reaching = (assignmentRows ?? []).filter(a => {
    if (a.kind === 'client') return a.client_id === id
    if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
    return a.client_group_id !== null && a.client_group_id === client.client_group_id
  })

  const usedBucketIds = [...new Set(reaching.map(a => a.bucket_id).filter(Boolean) as string[])]

  const [{ data: buckets }, { data: groups }] = await Promise.all([
    usedBucketIds.length
      ? service.from('buckets').select('id, name').in('id', usedBucketIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    client.client_group_id
      ? service.from('client_groups').select('id, name').eq('id', client.client_group_id)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ])

  const bucketName = new Map((buckets ?? []).map(b => [b.id, b.name]))
  const groupName = new Map((groups ?? []).map(g => [g.id, g.name]))

  const assignments: ResolvableAssignment[] = reaching.map(a => ({
    rule_id: a.rule_id,
    kind: a.kind,
    via_name:
      a.kind === 'bucket'
        ? bucketName.get(a.bucket_id!) ?? null
        : a.kind === 'client_group'
          ? groupName.get(a.client_group_id!) ?? null
          : null,
  }))

  // Resolved WITHOUT the client's switches, then reported alongside them. The
  // screen needs to show a rule that is configured but switched off — "you have
  // a markup, it is not being applied" is a different and more useful message
  // than showing nothing at all.
  const resolved = resolveCommercials({ rules, assignments })

  const enabled: Record<CommercialKind, boolean> = {
    markup: client.markup_active !== false,
    discount: client.discount_active === true,
    processing_fee: client.processing_fee_active === true,
  }

  const effective: EffectiveRule[] = (['markup', 'discount', 'processing_fee'] as CommercialKind[])
    .map(kind => {
      const r = resolved[kind]
      if (!r) return null
      return {
        kind,
        label: KIND_LABELS[kind],
        ruleId: r.rule.id,
        summary: summarise(r),
        via: r.via,
        source: r.kind,
        sourceName: r.viaName,
        ambiguous: r.ambiguous,
        beat: r.beat,
      }
    })
    .filter((r): r is EffectiveRule => r !== null)

  return Response.json({ ok: true, effective, enabled })
}
