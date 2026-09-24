import { round2 } from '@/app/lib/commercials/fareComponents'
import { db } from '@/app/lib/db'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'
import { visibleLines, ADJUSTMENT_LABELS } from '@/app/lib/commercials/adjustment'
import type { CommercialsRecord } from '@/app/lib/commercials/composeSellPrice'
import { travellerItinerary } from '@/app/lib/book/travellerView'
import { NextRequest } from 'next/server'

// ── GET /api/public/ticket/[token] ───────────────────────────────────────────
// The e-ticket, for whoever holds the link. NO AUTHENTICATION, by design.
//
// This is what the QR on the ticket points at. The whole value is that it opens
// on a phone at an airport without a login — a colleague collecting someone, a
// visa desk, a manager checking a flight time. A page that demands a password
// solves none of those.
//
// ITS OWN PROJECTION, DELIBERATELY. It would have been less code to relax
// /api/book/[bookingId] and let this reuse it, and that is exactly the mistake
// worth not making: a change to the authenticated response would silently widen
// the unauthenticated one. Two routes, two lists of columns, neither able to
// leak on the other's behalf.
//
// WHAT IT SHOWS — an itinerary receipt, which is what a ticket is: flights,
// terminals, stops, PNR, ticket numbers, passenger names, seats, meals, baggage,
// contact details, and the fare with its tax breakdown. Omitting the money would
// make it useless for the thing tickets are most often needed for.
//
// WHAT IT WITHHOLDS, and why only these two:
//   · The passport is masked to its last four digits.
//   · The date of birth is not returned at all.
// Those are the pair that turns a forwarded link into identity fraud, and
// neither is any use at a gate. Real airline receipts do not print a date of
// birth either. Everything else a traveller would want to forward is present.
//
// The airline's own figures — total_cost, commercials, the markup — are absent
// here as they are everywhere on the traveller's side, and on an unauthenticated
// page most of all.
// ─────────────────────────────────────────────────────────────────────────────

interface PassengerSnapshot {
  Title?: string
  FirstName?: string
  MiddleName?: string
  LastName?: string
  PaxType?: string
  MealCode?: string
  PassportNumber?: string
  SeatListDetails?: { SeatDesignator: string; SeatFee: string; FlightNumber: string; FlightTime: string }[]
}

// "1234567890" → "••••7890". Done here rather than in the page so the full
// number never leaves the server — masking in the markup would ship the real
// one to the browser and hide it with CSS, which is not masking.
function maskPassport(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}

export const GET = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) => {
  const { token } = await params

  // Length-checked before it reaches the database. A token is 32 hex
  // characters; anything else is a probe, and answering it with the same 404
  // as a wrong-but-plausible token gives a scanner nothing to work with.
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return Response.json({ error: 'Ticket not found' }, { status: 404 })
  }

  const booking = await bookingsRepo.byShareToken(db, token)

  // Only a ticketed booking has a ticket. A cancelled or failed one keeps its
  // token — revoking is a deliberate act, not a side effect of a status change —
  // but there is nothing to show for it.
  if (!booking || booking.status !== 'ticketed') {
    return Response.json({ error: 'Ticket not found' }, { status: 404 })
  }

  const commercials = booking.commercials as unknown as CommercialsRecord | null
  const airline = commercials?.airline
  const markup = airline ? round2(commercials!.displayedFare - airline.total) : 0
  const taxTotal = airline
    ? round2(
        (airline.taxLines ?? []).reduce((sum: number, t: { amount: number }) => sum + t.amount, 0)
        || airline.otherTax + airline.fuelSurcharge
      )
    : null

  const snapshot = booking.traveler_snapshot as {
    Email?: string
    Mobile?: string
    PassengerDetails?: PassengerSnapshot[]
  } | null

  const ticketNumbers = (booking.ticket_numbers ?? []) as (string | null)[]

  return Response.json({
    ok: true,
    ticket: {
      pnr: booking.pnr,
      reference: booking.provider_order_id,
      // Projected: the frozen itinerary carries provider session keys, and
      // this page needs no login. See app/lib/book/travellerView.
      itinerary: travellerItinerary(booking.itinerary),
      passengers: (snapshot?.PassengerDetails ?? []).map((p, i) => ({
        title: p.Title,
        firstName: p.FirstName,
        middleName: p.MiddleName,
        lastName: p.LastName,
        paxType: p.PaxType,
        mealCode: p.MealCode,
        // Masked, and no dateOfBirth field exists on this response at all —
        // not null, absent, so it cannot be reintroduced by accident.
        passport: maskPassport(p.PassportNumber),
        ticketNumber: ticketNumbers[i] ?? null,
        seats: p.SeatListDetails ?? [],
      })),
      contact: {
        email: snapshot?.Email ?? null,
        mobile: snapshot?.Mobile ?? null,
      },
      fare: {
        currency: (booking.fare_breakdown as { currency?: string } | null)?.currency ?? 'INR',
        // Sell-side throughout: base carries the markup, so nothing here can be
        // subtracted to recover it.
        base: airline ? round2(airline.base + markup) : null,
        taxTotal,
        taxLines: airline?.taxLines ?? [],
        fare: commercials?.displayedFare ?? null,
        lines: visibleLines(commercials?.adjustments ?? []).map(a => ({
          label: ADJUSTMENT_LABELS[a.source],
          sign: a.sign,
          amount: a.amount,
        })),
        seatFees: (booking.fare_breakdown as { seatFees?: number } | null)?.seatFees ?? 0,
        total: booking.sell_total ?? null,
      },
    },
  })
})
