import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import { isUuid } from '@/app/lib/book/bookingActor'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import * as bookings from '@/app/lib/repositories/bookings'
import * as approvals from '@/app/lib/repositories/approvals'
import * as refunds from '@/app/lib/repositories/refunds'
import * as audit from '@/app/lib/repositories/audit'
import * as commercials from '@/app/lib/repositories/commercials'
import { deskView } from '@/app/lib/commercials/deskView'
import { ADJUSTMENT_LABELS, type Adjustment } from '@/app/lib/commercials/adjustment'
import type { CommercialsRecord } from '@/app/lib/commercials/composeSellPrice'
import { buildReason } from '@/app/lib/approval-engine/resolveApprovalTier'
import { asFareRules } from '@/app/lib/book/fareRules'

// ── GET /api/tmc/bookings/[id] ───────────────────────────────────────────────
// One booking, all of it, for the TMC desk's booking page
// (/tmc/reports/bookings/[id], opened from the Bookings report):
//   - who travelled, for which client, who booked and confirmed it;
//   - the itinerary and passengers;
//   - the money: the airline's fare line by line, each commercial adjustment
//     with the rule that made it and how it reached the client, what the client
//     pays and the TMC's margin;
//   - the deal codes and form of payment stamped on it;
//   - the policy verdict, its breaches and any reason given;
//   - the approval history, the tickets, the cancellation and refunds;
//   - its audit trail, and the other booking of a round trip.
//
// The same reach as the reports (view_reports; a counsellor: their portfolio,
// refused outside it). Another TMC's booking is answered as missing.
// Never sent to a corporate user: they have no TMC permission at all.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> }

export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = await requireUser()
  if (!isUuid(id)) return Response.json({ error: 'Booking not found' }, { status: 404 })

  const booking = await bookings.deskDetail(db, id)
  if (!booking?.client_id) return Response.json({ error: 'Booking not found' }, { status: 404 })

  // The client is passed so a counsellor is held to their portfolio; the TMC
  // is compared because a TMC admin passes the permission for any client id.
  const auth = await requireTmcPermission(db, user.id, 'view_reports', booking.client_id)
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  if (booking.tmc_id !== auth.tmcId) return Response.json({ error: 'Booking not found' }, { status: 404 })

  const record = booking.commercials as CommercialsRecord | null
  const adjustments: Adjustment[] = Array.isArray(record?.adjustments) ? record.adjustments : []
  const ruleIds = [...new Set(adjustments.map(a => a.ruleId).filter((r): r is string => Boolean(r)))]

  const [steps, ticketRefunds, trail, pair, rules] = await Promise.all([
    approvals.historyForBooking(db, booking.pair_id && booking.pair_id !== booking.id ? booking.pair_id : booking.id),
    refunds.forBookingDesk(db, booking.id),
    audit.forEntity(db, 'booking', booking.id),
    bookings.pairMembers(db, booking.id),
    commercials.ruleLabels(db, auth.tmcId, ruleIds),
  ])
  const ruleById = new Map(rules.map(r => [r.id, r]))

  const breaches = (booking.policy_verdict_detail as { breaches?: unknown[] } | null)?.breaches ?? []
  const bookedBy = !booking.booked_by || booking.booked_by === booking.employee_id ? 'self'
    : booking.booked_by_role === 'tmc_admin' || booking.booked_by_role === 'tc' ? 'desk' : 'colleague'

  return Response.json({
    ok: true,
    booking: {
      id: booking.id,
      status: booking.status,
      createdAt: booking.created_at,
      updatedAt: booking.updated_at,
      purpose: booking.purpose,
      forGuest: booking.for_guest,
      client: { id: booking.client_id, name: booking.client_name },
      traveller: { id: booking.employee_id, name: booking.traveller_name, email: booking.traveller_email, band: booking.traveller_band },
      bookedBy: { kind: bookedBy, name: booking.booked_by_name },
      confirmedBy: booking.confirmed_by_name,
      trip: booking.trip_id ? { id: booking.trip_id, name: booking.trip_name } : null,
      references: {
        pnr: booking.pnr, airlinePnr: booking.airline_pnr, providerReference: booking.provider_order_id,
        provider: booking.provider, ticketNumbers: booking.ticket_numbers ?? [],
      },
      itinerary: booking.itinerary,
      passengers: (booking.traveler_snapshot as { PassengerDetails?: unknown[] } | null)?.PassengerDetails ?? [],
      contact: (() => {
        const s = booking.traveler_snapshot as { Email?: string; Mobile?: string } | null
        return s ? { email: s.Email ?? null, mobile: s.Mobile ?? null } : null
      })(),
      fare: booking.fare_breakdown,
      money: {
        // What the airline is owed and what the client is invoiced, as stored.
        airlineTotal: booking.total_cost,
        sellTotal: booking.sell_total ?? booking.total_cost,
        // Null on a booking made before commercials were recorded.
        airline: record?.airline ?? null,
        adjustments: adjustments.map(a => ({
          source: a.source,
          label: ADJUSTMENT_LABELS[a.source] ?? a.source,
          sign: a.sign,
          amount: a.amount,
          // Folded into the fare (markup) or shown to the client as a line.
          visibility: a.visibility,
          // The rule as it stands now: whose airline, and whether still in force.
          rule: a.ruleId ? {
            id: a.ruleId,
            airline: ruleById.get(a.ruleId)?.airline_code ?? null,
            active: ruleById.get(a.ruleId)?.active ?? null,
          } : null,
          via: a.via,
          calcType: a.calcType ?? null, calcOn: a.calcOn ?? null, rate: a.rate ?? null,
          calcBasis: a.calcBasis ?? null, pax: a.pax ?? null, sectors: a.sectors ?? null,
        })),
        desk: deskView(record),
        ambiguous: record?.ambiguous ?? false,
      },
      dealCodes: booking.resolved_deal_codes,
      formOfPayment: booking.resolved_fop,
      // The airline's rules as priced (or as last fetched by PNR), deal code
      // included: the cancellation charges a refund is worked out from.
      fareRules: asFareRules(booking.fare_rules),
      policy: {
        status: booking.policy_status,
        verdict: booking.policy_verdict,
        breaches,
        reason: breaches.length ? buildReason(breaches as Parameters<typeof buildReason>[0]) : null,
        reasonCode: booking.policy_reason_code,
        reasonNote: booking.policy_reason_note,
      },
      approvals: steps.map(s => ({
        id: s.id, tier: s.tier, status: s.status, verdict: s.verdict, reason: s.reason,
        approver: s.approver_name, note: s.decision_note, askedAt: s.created_at, decidedAt: s.actioned_at,
      })),
      // A round trip's one approval lives on its first booking.
      approvalOnPair: Boolean(booking.pair_id && booking.pair_id !== booking.id),
      cancellation: booking.cancelled_at ? {
        at: booking.cancelled_at, by: booking.cancelled_by_name, reason: booking.cancellation_reason,
        provider: booking.cancellation,
      } : null,
      refunds: ticketRefunds.map(r => ({
        id: r.id, passengerIndex: r.passenger_index, ticketNumber: r.ticket_number, status: r.status,
        refundAmount: r.refund_amount, tmcKept: r.tmc_retained, creditNote: r.credit_note_no,
        processedAt: r.processed_at, rejectedReason: r.rejected_reason,
      })),
      pair: pair.map((p, i) => ({ id: p.id, status: p.status, pnr: p.pnr, direction: i === 0 ? 'onward' : 'return' })),
      audit: trail.map(a => ({ id: a.id, action: a.action, at: a.created_at, by: a.user_name, metadata: a.metadata })),
    },
  })
})
