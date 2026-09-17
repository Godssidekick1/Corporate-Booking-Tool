import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { amadeus, type PricingResponse } from '@/app/lib/amadeus/client'
import { stampCommercials } from '@/app/lib/commercials/stampCommercials'
import { emptyCommercials, type CommercialsRecord } from '@/app/lib/commercials/composeSellPrice'
import { round2, type FareComponents } from '@/app/lib/commercials/fareComponents'
import { visibleLines, ADJUSTMENT_LABELS } from '@/app/lib/commercials/adjustment'
import type { ResolvedCommercials } from '@/app/lib/commercials/resolveCommercials'
import { cabinLetter } from '@/app/lib/book/cabin'
import type { FlatFlightResult } from '@/app/lib/book/types'
import { NextRequest } from 'next/server'

// POST /api/book/price
// Calls Pricing for the SPECIFIC flight result the user selected. Does not
// retry against other results — if this exact fare isn't priceable anymore
// (can genuinely happen: fare expired, seat bucket sold out between search
// and selection), we tell the user clearly rather than silently pricing a
// different flight than the one they picked.

// The real Pricing response is shaped just like Availability — nested
// under AirPricingResponse[0].PricingInfos.PricingInfo[0], NOT flat
// top-level fields. There is no PassengerFareBreakup field either; the
// per-passenger breakdown is FareBreakDowns.FareBreakDown[], one entry
// per PaxType, same pattern as Availability's FareInfos.
//
// Exported so other callers that need a fresh price (e.g.
// /api/approvals/[approvalId]/refresh-fare, which re-prices a booking an
// approver is reviewing) can reuse the exact same extraction instead of
// re-deriving this traversal independently and risking it drifting out of
// sync with reality.
export function extractPricingDetails(pricing: PricingResponse) {
  const flight = pricing.AirPricingResponse?.[0]
  const pricingInfo = flight?.PricingInfos?.PricingInfo?.[0]
  const fareBreakdown = pricingInfo?.FareBreakDowns?.FareBreakDown ?? []

  if (!pricingInfo) return null

  return {
    key: pricing.Key,
    referenceNo: pricing.ReferenceNo,
    totalFare: pricingInfo.Total?.Fare ? Number(pricingInfo.Total.Fare) : undefined,
    baseFare: pricingInfo.Total?.BaseFare ? Number(pricingInfo.Total.BaseFare) : undefined,
    tax: pricingInfo.Total?.OtherTax ? Number(pricingInfo.Total.OtherTax) : undefined,
    // Itemised taxes and the fuel surcharge, for commercial rules that
    // calculate on a named component (BF+YQ, BF+YQ+YR, other_tax). Both arrive
    // on every response and were simply never read before this.
    //
    // NOTE for anyone reconciling these: `tax` is Total.OtherTax while
    // FuelSurcharge is a SIBLING field, so totalFare - baseFare does not
    // reliably equal tax. Use taxLines when a specific code matters.
    taxLines: fareBreakdown[0]?.Taxes?.Tax
      ? fareBreakdown[0].Taxes.Tax.map(t => ({ code: t.TaxCode, amount: Number(t.Amount) || 0 }))
      : undefined,
    fuelSurcharge: pricingInfo.Total?.FuelSurcharge
      ? Number(pricingInfo.Total.FuelSurcharge)
      : undefined,
    currency: pricingInfo.Currency,
    isRefundable: fareBreakdown[0]?.Refundable === 'Refundable',
    fareType: pricingInfo.FareType,
    fareBasis: pricingInfo.FareInfos?.FareInfo?.[0]?.PaxFareBasis || undefined,
    mealIncluded: pricingInfo.Meal === 'YES',
    // Baggage is deliberately NOT returned here any more.
    //
    // It is filed per flown segment (Itineraries.Itinerary[].Baggage) and has
    // no per-fare node at all, so a value taken from a pricing call for ONE
    // fare is not a fact about that fare — it is the same itinerary-level
    // allowance the search response already carried. Returning it caused the
    // fare card being priced to source its baggage from here while its
    // siblings sourced theirs from search, which is how one card in a list of
    // six could show a different allowance for no real reason.
    //
    // The price page reads it off the journey instead, where it belongs.
    changePenalties: (pricingInfo.Penalties?.ChangePenalty ?? []).map(p => ({ paxType: p.PaxType, text: p.Text.trim() })),
    cancelPenalties: (pricingInfo.Penalties?.CancelPenalty ?? []).map(p => ({ paxType: p.PaxType, text: p.Text.trim() })),
    passengerBreakup: fareBreakdown.map(fb => ({
      PaxType: fb.PaxType,
      BaseFare: Number(fb.BaseFare),
      Tax: Number(fb.TotalTax),
      TotalFare: Number(fb.TotalFare),
    })),
    brandedFareName: pricingInfo.BrandedFareName || undefined,
    brandedFareDescription: pricingInfo.BrandedfareDesc || undefined,
    brandedServices: pricingInfo.BrandedFareService
      ? pricingInfo.BrandedFareService.split('|').map(s => s.trim()).filter(Boolean)
      : undefined,
  }
}

// ── logCommercialDecision ────────────────────────────────────────────────────
// One block per priced itinerary, written to the server log and nowhere else.
//
// Formatted to be read by a person at 2am rather than parsed by a machine: the
// dimensions the rules are matched on first, then one line per assigned rule
// saying whether it applied and — when it did not — which two values disagreed.
// A rejection reason with only the losing field name ("cabin") sends someone
// back to the editor to guess; one that names both sides ends the question.
function logCommercialDecision(
  resolved: ResolvedCommercials | null,
  record: CommercialsRecord,
  flight: FlatFlightResult | null
) {
  const markup = round2(record.displayedFare - record.airline.total)
  const amountFor = (source: string) =>
    record.adjustments.find(a => a.source === source)?.amount ?? 0

  const lines: string[] = []
  lines.push(
    `[commercials] ${flight?.origin?.code ?? '???'}→${flight?.destination?.code ?? '???'} ` +
    `${flight?.airline?.code ?? '??'} · cabin ${cabinLetter(flight?.cabin) ?? '?'} (${flight?.cabin ?? 'unknown'}) · ` +
    `classes ${(flight?.legs ?? []).map(l => l.bookingCode || '?').join(',') || 'none'} · ` +
    `${flight?.isLcc ? 'LCC' : 'BSP'}`
  )

  if (!resolved) {
    lines.push('  no client on this employee — priced at the airline fare')
  } else if (resolved.trace.length === 0) {
    lines.push('  no commercial rule is assigned to this client')
  } else {
    for (const t of resolved.trace) {
      const mark = t.won ? '✓' : '✗'
      const amount = t.won ? `  → ${amountFor(t.kind).toFixed(2)}` : ''
      lines.push(`  ${mark} ${t.kind.padEnd(15)} ${t.via.padEnd(22)} ${t.detail}${amount}`)
    }
  }

  lines.push(
    `  airline ${record.airline.total.toFixed(2)} ` +
    `→ fare ${record.displayedFare.toFixed(2)} (markup ${markup.toFixed(2)}) ` +
    `→ sell ${record.sellTotal.toFixed(2)} ` +
    `(discount ${amountFor('discount').toFixed(2)}, fee ${amountFor('processing_fee').toFixed(2)})`
  )

  console.info(lines.join('\n'))
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // `itinerary` is the FlatFlightResult the traveller selected. New here, and
  // needed because a commercial rule matches on category (domestic/international
  // × BSP/LCC), airline, cabin and booking class — none of which can be read
  // from a pricing key. It is the same object search already returned to them,
  // so nothing new is being trusted: every figure on it is re-derived here from
  // Amadeus's own response, and only the ROUTE shape is taken from the client.
  const { key, pricingKey, provider, resultIndex, itinerary } = await req.json()

if (!key || !pricingKey || !provider || !resultIndex) {
  return Response.json(
    { error: 'key, pricingKey, provider, and resultIndex are required' },
    { status: 400 }
  )
}

  try {
    // The employee lookup is started BEFORE the provider call and awaited after
    // it. It does not depend on the pricing response — it only needs the user
    // id we already have — so running it afterwards put a database round trip
    // on the end of a call that already takes seconds.
    //
    // Deliberately not Promise.all: pricing is the one that can fail in an
    // interesting way, and awaiting it first keeps the existing catch handling
    // (fare_not_found, AmadeusError) exactly as it was.
    const service = createServiceClient()
    const employeePromise = service
      .from('employees')
      .select('id, client_id')
      .eq('id', user.id)
      .maybeSingle()

    const pricing = await amadeus.pricing(key, pricingKey, provider, resultIndex)
    const details = extractPricingDetails(pricing)

    if (!details) {
      return Response.json({
        ok: false,
        error: 'Pricing succeeded but returned no fare details. Please try again.',
      }, { status: 200 })
    }

    // ── Commercials ──────────────────────────────────────────────────────────
    // The full pipeline runs here, not at search: discount and processing fee
    // depend on passenger and sector counts, which only exist once an itinerary
    // is priced.
    //
    // This route used to do auth.getUser() and nothing else. It needs the
    // employee's client now, because a price is a price FOR SOMEBODY.
    const { data: employee } = await employeePromise

    const components: FareComponents = {
      base: details.baseFare ?? 0,
      otherTax: details.tax ?? 0,
      fuelSurcharge: details.fuelSurcharge ?? 0,
      taxLines: details.taxLines ?? [],
      total: details.totalFare ?? 0,
    }

    const pax = Math.max(1, details.passengerBreakup?.length ?? 1)

    const stamped = employee?.client_id
      ? await stampCommercials(service, {
          clientId: employee.client_id,
          flight: (itinerary as FlatFlightResult | null) ?? null,
          components,
          pax,
        })
      : { record: emptyCommercials(components), resolved: null }

    const { record } = stamped

    // ── Why this price ───────────────────────────────────────────────────────
    // The one place a markup can be confirmed at all.
    //
    // A markup is deliberately undiscoverable from the browser: folded into the
    // base and total, stripped from every response, and indistinguishable from
    // the airline simply charging more. That is the design working — but it also
    // means nobody can tell a markup that applied from one that silently did not,
    // and "is this even on?" is not a question that should require reading code.
    //
    // A discount or a fee that does not appear has the same problem from the
    // other side: the line is absent either because no rule matched or because
    // the rule that was supposed to match is filed against something this flight
    // is not. Those look identical on screen and have completely different fixes.
    //
    // So the whole decision is logged SERVER-SIDE, where the airline figures
    // already live and where the traveller cannot reach it. Read it in the
    // terminal running `npm run dev`, or in the Vercel function logs.
    logCommercialDecision(stamped.resolved, record, itinerary as FlatFlightResult | null)

    // ── Persist the quote ────────────────────────────────────────────────────
    // This is what takes price authority away from the browser. The browser is
    // never told the airline figure — that is the whole point of an embedded
    // markup — so the server has to be able to recover it at booking time, or we
    // would end up quoting our own markup to the airline.
    //
    // Upserted on (amadeus_key, reference_no): re-pricing the same itinerary is
    // a normal thing to do, and the newest quote is the one that counts.
    if (employee?.client_id) {
      const { error: quoteError } = await service.from('price_quotes').upsert({
        client_id: employee.client_id,
        employee_id: employee.id,
        amadeus_key: details.key,
        reference_no: details.referenceNo,
        pricing_key: pricingKey,
        provider,
        result_index: resultIndex,
        airline_components: components,
        commercials: record,
        sell_total: record.sellTotal,
        // Comfortably longer than a booking flow and shorter than a fare's own
        // life. A missing quote is recoverable — add-passenger falls back to
        // re-pricing — so an aggressive TTL costs latency, not correctness.
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'amadeus_key,reference_no' })

      if (quoteError) {
        // Not fatal. The traveller can still be quoted; add-passenger will
        // re-price rather than trust the browser.
        console.error('[price] could not persist the quote', quoteError)
      }
    }

    // ── What the browser is allowed to see ───────────────────────────────────
    // Sell-side only. taxLines, fuelSurcharge, the airline total and every
    // markup figure are removed — not hidden in the payload, removed, because
    // anything sent is visible in devtools.
    //
    // Built by deleting from a copy rather than by destructuring the two keys
    // into throwaway variables: this config has no varsIgnorePattern, so the
    // `_unused` convention is a lint warning here.
    const safe: Partial<typeof details> = { ...details }
    delete safe.taxLines
    delete safe.fuelSurcharge

    const sellBase = round2(components.base + (record.displayedFare - components.total))

    return Response.json({
      ok: true,
      ...safe,
      // The "Fare" line: the airline fare with markup folded in, indistinguishable.
      totalFare: record.displayedFare,
      baseFare: sellBase,
      // ── Taxes: EVERY tax, not just OtherTax ────────────────────────────────
      // `details.tax` is Total.OtherTax, and FuelSurcharge is a SIBLING field —
      // the trap this file already warns about in extractPricingDetails, which
      // the response then walked straight into by shipping OtherTax as "tax".
      //
      // The price page renders base, tax and total as a breakdown, so a
      // traveller reading a real DEL→BOM quote saw 12,358 + 2,246 against a
      // total of 15,702 and was short by the 1,098 of fuel surcharge. That is
      // precisely the "adds up the breakdown and finds an unexplained
      // difference" that the whole embedded-markup design exists to prevent —
      // an unexplained gap in a fare breakdown invites exactly one guess.
      //
      // Derived as total − base rather than by adding the two components back
      // together, so it reconciles by construction and cannot drift again if
      // the provider adds a third sibling. Both figures here are sell-side and
      // carry the same markup, so their difference is the airline's tax exactly
      // and this leaks nothing the total did not already imply.
      tax: round2(record.displayedFare - sellBase),
      // Discount and processing fee, each as its own labelled line. Never the
      // embedded one — visibleLines() is what enforces that.
      lines: visibleLines(record.adjustments).map(a => ({
        source: a.source,
        label: ADJUSTMENT_LABELS[a.source],
        sign: a.sign,
        amount: a.amount,
      })),
      // What they pay, before seat fees.
      sellTotal: record.sellTotal,
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