import { createClient } from '@/utils/supabase/server'
import { amadeus, AmadeusError, sanitizeAmadeusDiagnostic } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'
import util from 'util'

// ── POST /api/book/seatmap ────────────────────────────────────────────────────
// Sits right after Price, before AddPassenger, in the booking chain
// (search → price → seatmap + add-passenger (details) → book → ticket).
//
// One call = one leg. For a connecting itinerary the frontend calls this once
// per segment, same as how the airline's own SeatMap endpoint is scoped —
// there is no "whole itinerary" seat map call.
//
// This is purely a lookup — nothing is persisted here. Selected seats are
// carried forward by the frontend (sessionStorage, same as the priced fare)
// and only submitted for real inside customerInfo.PassengerDetails[].SeatListDetails
// on /api/book/add-passenger.
//
// Flattening notes, confirmed against a real full-cabin response:
// - Real seat cells always carry SeatDesignator already in "22-B" form and
//   TravelClassCode other than "NA" — those are the only rows worth showing.
// - "Hidden" rows (Assignable: false, Message: "hide", TravelClassCode: "NA",
//   numeric-junk SeatDesignator like "11") represent cabins/sections this
//   fare simply can't see or select — filtered out entirely, not shown greyed
//   out, since they're not real seat positions from this fare's perspective.
// - ColumnNo is not usable for column position (0 for every real seat) — the
//   BLANK filler cell in each row (the walkway) is dropped, and the remaining
//   real seats keep their natural array order for left-to-right rendering.
// ─────────────────────────────────────────────────────────────────────────────

interface SeatMapBody {
  key: string          // Key from the Pricing response (/api/book/price)
  referenceNo: string  // ReferenceNo from /api/book/price
  provider: string
  origin: string       // this leg's origin airport code
  destination: string  // this leg's destination airport code
  legIndex: number      // which leg this is, for the frontend to key its state by
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { key, referenceNo, provider, origin, destination, legIndex }: SeatMapBody = await req.json()

  if (!key || !referenceNo || !provider || !origin || !destination || legIndex === undefined) {
    return Response.json(
      { error: 'key, referenceNo, provider, origin, destination, and legIndex are required' },
      { status: 400 }
    )
  }

  try {
    const result = await amadeus.seatMap(key, referenceNo, provider, origin, destination)

    // Real response has no Status/Error worth trusting as a hard failure
    // signal (both were seen null even on a normal successful call) — the
    // only reliable "did this work" check is whether DeckData actually came
    // back with something in it.
    const finalDetails = result.DeckData?.SeatMapAll?.[0]?.SeatMapDetails_Final?.[0]
    if (!finalDetails) {
      console.warn('SeatMap: no SeatMapDetails_Final in response', {
        origin, destination, legIndex,
        hasDeckData: Boolean(result.DeckData),
        seatMapAllLength: result.DeckData?.SeatMapAll?.length ?? 0,
        rawKeys: result.DeckData ? Object.keys(result.DeckData) : [],
      })
      return Response.json({
        ok: true,
        available: false,
        legSeatMap: null,
      })
    }

    const rawSeats = finalDetails.SeatMapDetails?.[0]?.SeatListDetails ?? []
    if (rawSeats.length === 0) {
      console.warn('SeatMap: SeatMapDetails_Final present but SeatListDetails empty', {
        origin, destination, legIndex,
        seatMapDetailsLength: finalDetails.SeatMapDetails?.length ?? 0,
      })
    }

    // Keep only real, selectable-cabin seats — drop the walkway (BLANK) and
    // rows this fare can't see (numeric-junk SeatDesignator, TravelClassCode "NA").
    const seats = rawSeats
      .filter(s => s.SeatStatus !== 'BLANK' && s.TravelClassCode !== 'NA')
      .map(s => ({
        rowNo: s.RowNo,
        seatDesignator: s.SeatDesignator,
        seatAlignment: s.SeatAlignment,
        seatStatus: s.SeatStatus,
        seatFee: s.SeatFee,
        paid: s.Paid,
        travelClassCode: s.TravelClassCode,
        flightNumber: s.FlightNumber,
        flightTime: s.FlightTime,
        equipment: s.Equipment,
        carrier: s.Carrier,
        group: s.Group,
        classOfService: s.ClassOfService,
        optionalServiceRef: s.OptionalServiceRef,
        segmentRef: s.SegmentRef,
        exitSeats: s.ExitSeats,
        hidden: false,
      }))

    return Response.json({
      ok: true,
      available: seats.length > 0,
      legSeatMap: {
        legIndex,
        origin,
        destination,
        flightNumber: finalDetails.FlightNumber,
        flightTime: finalDetails.FlightTime,
        columns: result.DeckData?.Columns ?? 0,
        rows: result.DeckData?.Rows ?? 0,
        available: seats.length > 0,
        seats,
      },
    })
  } catch (err) {
    if (err instanceof AmadeusError) {
      console.error('SeatMap error', {
        requestId: err.requestId,
        code: err.code,
        category: err.category,
        request: sanitizeAmadeusDiagnostic(err.requestBody),
        raw: sanitizeAmadeusDiagnostic(err.raw),
      })
      console.error('SeatMap error (full, untruncated raw):', util.inspect(sanitizeAmadeusDiagnostic(err.raw), { depth: null, colors: false }))

      // Seat maps aren't always available for every fare/carrier — treat an
      // Amadeus-side error here as "no seat map for this flight" rather than
      // a hard failure, so the booking flow can still proceed without seats.
      return Response.json({
        ok: true,
        available: false,
        legSeatMap: null,
        reason: err.message,
      })
    }

    console.error('SeatMap error:', err)
    return Response.json({
      ok: true,
      available: false,
      legSeatMap: null,
    })
  }
}