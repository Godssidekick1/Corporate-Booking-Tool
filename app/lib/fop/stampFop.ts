import { resolveFop, type ResolvableFopAssignment, type ResolvedFop } from './resolveFop'
import { loadClientGates } from '@/app/lib/clients/clientGates'
import type { FlatFlightResult } from '@/app/lib/book/types'
import type { Queryable } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as fopRepo from '@/app/lib/repositories/fop'

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
  db: Queryable,
  clientId: string,
  flight: FlatFlightResult | null
): Promise<StampedFop | null> {
  try {
    const client = await clients.stampProfile(db, clientId)

    if (!client?.tmc_id) return null

    const [fops, bucketIds, assignmentRows] = await Promise.all([
      fopRepo.forResolution(db, client.tmc_id),
      clients.bucketIdsOfClient(db, clientId),
      fopRepo.assignmentsForTmc(db, client.tmc_id),
    ])

    if (fops.length === 0) return null

    // Which payer types this client permits. Read here rather than inside
    // resolveFop so that function stays pure and testable without a database.
    const gates = await loadClientGates(db, clientId)

    // A switched-off mapping does not reach this client. It no longer needs to
    // be tracked separately either: the fallback is now the form of payment
    // flagged is_default, so suspending a mapping cannot promote anything.
    const reaching = assignmentRows.filter(a => {
      if (!a.is_active) return false
      if (a.kind === 'client') return a.client_id === clientId
      if (a.kind === 'bucket') return a.bucket_id !== null && bucketIds.includes(a.bucket_id)
      return a.client_group_id !== null && a.client_group_id === client.client_group_id
    })

    // Names only for the routes that actually reached this client — no point
    // fetching every bucket in the TMC to label two of them.
    const usedBucketIds = [...new Set(reaching.map(a => a.bucket_id).filter((b): b is string => Boolean(b)))]

    const [buckets, groupName] = await Promise.all([
      clients.bucketLabels(db, usedBucketIds),
      clients.groupNames(db, client.client_group_id ? [client.client_group_id] : []),
    ])

    const assignments: ResolvableFopAssignment[] = reaching.map(a => ({
      fop_id: a.fop_id,
      kind: a.kind as ResolvableFopAssignment['kind'],
      via_name:
        a.kind === 'bucket'
          ? buckets.get(a.bucket_id!)?.name ?? null
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
      allowedPayers: gates.allowedPayers,
      paymentPriority: gates.paymentPriority,
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
