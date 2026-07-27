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
    const pricing = await amadeus.pricing(key, pricingKey, provider, resultIndex)

    return Response.json({
      ok: true,
      referenceNo: pricing.ReferenceNo,
      totalFare: pricing.TotalFare,
      baseFare: pricing.BaseFare,
      tax: pricing.Tax,
      currency: pricing.Currency,
      isRefundable: pricing.IsRefundable,
      fareType: pricing.FareType,
      passengerBreakup: pricing.PassengerFareBreakup,
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