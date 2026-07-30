import { createClient } from '@/utils/supabase/server'
import { amadeus } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'

// POST /api/book/price
// Calls Pricing for the SPECIFIC flight result the user selected. Does not
// retry against other results — if this exact fare isn't priceable anymore
// (can genuinely happen: fare expired, seat bucket sold out between search
// and selection), we tell the user clearly rather than silently pricing a
// different flight than the one they picked.

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { key, pricingKey, provider, resultIndex } = await req.json()

if (!key || !pricingKey || !provider || !resultIndex) {
  return Response.json(
    { error: 'key, pricingKey, provider, and resultIndex are required' },
    { status: 400 }
  )
}

  try {
    // sessionId must be the SessionID from the SAME search (/api/book/search)
    // that produced this key/pricingKey — not the currently cached session,
    // which may have rotated since. Amadeus rejects Pricing run under any
    // session other than the one that generated the result.
    const pricing = await amadeus.pricing(key, pricingKey, provider, resultIndex)

    // The real Pricing response is shaped just like Availability — nested
    // under AirPricingResponse[0].PricingInfos.PricingInfo[0], NOT flat
    // top-level fields. There is no PassengerFareBreakup field either; the
    // per-passenger breakdown is FareBreakDowns.FareBreakDown[], one entry
    // per PaxType, same pattern as Availability's FareInfos.
    const flight = pricing.AirPricingResponse?.[0]
    const pricingInfo = flight?.PricingInfos?.PricingInfo?.[0]
    const fareBreakdown = pricingInfo?.FareBreakDowns?.FareBreakDown ?? []

    if (!pricingInfo) {
      return Response.json({
        ok: false,
        error: 'Pricing succeeded but returned no fare details. Please try again.',
      }, { status: 200 })
    }

    return Response.json({
      ok: true,
      key: pricing.Key,
      referenceNo: pricing.ReferenceNo,
      totalFare: pricingInfo.Total?.Fare ? Number(pricingInfo.Total.Fare) : undefined,
      baseFare: pricingInfo.Total?.BaseFare ? Number(pricingInfo.Total.BaseFare) : undefined,
      tax: pricingInfo.Total?.OtherTax ? Number(pricingInfo.Total.OtherTax) : undefined,
      currency: pricingInfo.Currency,
      isRefundable: fareBreakdown[0]?.Refundable === 'Refundable',
      fareType: pricingInfo.FareType,
      passengerBreakup: fareBreakdown.map(fb => ({
        PaxType: fb.PaxType,
        BaseFare: Number(fb.BaseFare),
        Tax: Number(fb.TotalTax),
        TotalFare: Number(fb.TotalFare),
      })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pricing failed'

    // "Fare Not Found" is a known, expected outcome — the fare shown in
    // search results is no longer priceable. This is a normal user-facing
    // state (ask them to pick another flight or search again), not a
    // server error — return 200 with ok:false rather than 500, so the
    // frontend can show a clean message instead of a generic failure.
    const isFareNotFound = message.toLowerCase().includes('fare not found')

    if (isFareNotFound) {
      return Response.json({
        ok: false,
        reason: 'fare_not_found',
        error: 'This fare is no longer available. Please search again or select a different flight.',
      }, { status: 200 })
    }

    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}