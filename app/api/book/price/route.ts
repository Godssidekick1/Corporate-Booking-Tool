import { createClient } from '@/utils/supabase/server'
import { amadeus } from '@/app/lib/amadeus/client'
import { NextRequest } from 'next/server'

// POST /api/book/price
// Calls Pricing for a selected flight result.
// Returns confirmed fare and ReferenceNo — both are required before AddPassenger.

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
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}