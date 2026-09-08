import { createServiceClient } from '@/utils/supabase/service'
import { resolveFop, type ResolvableFopAssignment, type ResolvedFop } from './resolveFop'
import type { FlatFlightResult } from '@/app/lib/book/types'

type ServiceClient = ReturnType<typeof createServiceClient>

// ── stampFop ─────────────────────────────────────────────────────────────────
// Resolves the form of payment for a booking and returns it for storage.
//
// FROZEN, NOT DERIVED LATER
// Assignments and cards change. A booking made in March must still show the
// card that applied in March, the same reason fare_breakdown is snapshotted
// rather than re-priced.
//
// NOT TRANSMITTED
// addPassenger does have a `Payment: Record<string, unknown>` slot, unlike the
// tour codes which had nowhere to go at all — but its expected shape is
// undocumented, and a silently-ignored payment object is indistinguishable from
// a working one until a ticket settles wrongly. So this records what SHOULD be
// used and nothing is sent. The shape below is deliberately payment-payload
// shaped so wiring it later is one call site.
//
// NEVER THROWS, NEVER BLOCKS. A booking must not fail because a payment rule
// could not be worked out — errors return null and the booking proceeds
// unstamped, exactly as checkBookingAgainstPolicy lets an unconfigured policy
// through.
// ─────────────────────────────────────────────────────────────────────────────

export interface StampedFop extends ResolvedFop {
  // Recorded so a counsellor reading this later knows the resolution was made
  // against a branch, and which one — a booking whose client had no branch set
  // resolved on TMC-wide rules only.
  branchId: string | null
}

export async function stampFop(
  service: ServiceClient,
  clientId: string,
  flight: FlatFlightResult | null
): Promise<StampedFop | null> {
  try {
    const { data: client } = await service
      .from('clients')
      .select('id, tmc_id, branch_id, client_group_id')
      .eq('id', clientId)
      .maybeSingle()

    if (!client) return null

    const [{ data: fops }, { data: bucketRows }, { data: assignmentRows }] = await Promise.all([
      service
        .from('forms_of_payment')
        .select(
          'id, label, fop_type, payer, card_type, last4, expiry_month, expiry_year, branch_id, airline_code, rbd_spec, active, is_default, created_at'
        )
        .eq('tmc_id', client.tmc_id),
      service.from('bucket_clients').select('bucket_id').eq('client_id', clientId),
      service
        .from('fop_assignments')
        .select('fop_id, kind, client_id, client_group_id, bucket_id, is_active')
        .eq('tmc_id', client.tmc_id),
    ])

    if (!fops || fops.length === 0) return null

    const bucketIds = (bucketRows ?? []).map(b => b.bucket_id)

    // A switched-off mapping does not reach this client. It no longer needs to
    // be tracked separately either: the fallback is now the form of payment
    // flagged is_default, so suspending a mapping cannot promote anything.
    const reaching = (assignmentRows ?? []).filter(a => {
      if (!a.is_active) return false
      if (a.kind === 'client') return a.client_id === clientId
      if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
      return a.client_group_id !== null && a.client_group_id === client.client_group_id
    })

    // Names only for the routes that actually reached this client — no point
    // fetching every bucket in the TMC to label two of them.
    const usedBucketIds = [...new Set(reaching.map(a => a.bucket_id).filter(Boolean) as string[])]

    const [{ data: buckets }, { data: groups }] = await Promise.all([
      usedBucketIds.length
        ? service.from('buckets').select('id, name').in('id', usedBucketIds)
        : Promise.resolve({ data: [] }),
      client.client_group_id
        ? service.from('client_groups').select('id, name').eq('id', client.client_group_id)
        : Promise.resolve({ data: [] }),
    ])

    const bucketName = new Map((buckets ?? []).map(b => [b.id, b.name]))
    const groupName = new Map((groups ?? []).map(g => [g.id, g.name]))

    const assignments: ResolvableFopAssignment[] = reaching.map(a => ({
      fop_id: a.fop_id,
      kind: a.kind,
      via_name:
        a.kind === 'bucket'
          ? bucketName.get(a.bucket_id!) ?? null
          : a.kind === 'client_group'
            ? groupName.get(a.client_group_id!) ?? null
            : null,
    }))

    // Every leg's booking code, which is what makes an RBD rule real: a card an
    // airline refuses in one class must not be applied because the first hop
    // happened to be in another.
    const legs = flight?.legs ?? []
    const legBookingCodes = legs.map(l => l.bookingCode)

    // The marketing carrier. Falls back to the flight-level airline for a
    // result whose legs were not mapped.
    const airlineCode = legs[0]?.airlineCode ?? flight?.airline?.code ?? null

    const resolved = resolveFop({
      fops,
      assignments,
      branchId: client.branch_id,
      airlineCode,
      legBookingCodes,
    })

    if (!resolved) return null

    return { ...resolved, branchId: client.branch_id }
  } catch (error) {
    console.error('[fop] could not resolve for booking', { clientId, error })
    return null
  }
}
