'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { flowStorage } from '@/app/lib/book/flowStorage'
import {
  FlatFlightResult, FareOption, formatTime, formatDayLabel, journeysOf, journeyLabel,
} from '@/app/lib/book/types'

// ── /book/price/[flightKey] — Step 2: Select fare ─────────────────────────────
// Merges what used to be two separate concepts into one screen:
//   1. Fare details already available from the Availability response
//      (baggage, fare basis, terminals, cancellation/change penalties, fare
//      type, refundability) — shown immediately, no extra API call.
//   2. Pricing — locks the live fare with the airline (unchanged from
//      before: same /api/book/price call, same flowStorage.savePricedFare).
//
// These run at the same time rather than gating one behind the other: fare
// details render the instant the page loads (from sessionStorage), while
// Pricing confirms in the background. If Pricing comes back with a
// different total than what search showed, the live number wins — search
// results are always provisional, Pricing is the source of truth.
//
// Fare options: today's real Amadeus responses only ever contain one
// PricingInfo per flight (confirmed against UAT), but the underlying shape
// is an array and production may return more than one — so this renders
// however many fareOptions actually exist, defaulting to the first when
// there's only one, rather than assuming there's exactly one.
// ─────────────────────────────────────────────────────────────────────────────

interface PriceApiResult {
  ok: boolean
  reason?: string
  error?: string
  key?: string
  referenceNo?: string
  totalFare?: number
  baseFare?: number
  tax?: number
  currency?: string
  isRefundable?: boolean
  fareType?: string
  fareBasis?: string
  mealIncluded?: boolean
  // cabinBaggageKg is gone from this response on purpose — baggage is filed
  // per flown segment, never per fare, so a value from a pricing call for one
  // fare was not a fact about that fare. It is read off the journey instead.
  changePenalties?: { paxType: string; text: string }[]
  cancelPenalties?: { paxType: string; text: string }[]
  passengerBreakup?: {
    PaxType: string
    BaseFare: number
    Tax: number
    TotalFare: number
  }[]
  // Commercial lines the traveller is allowed to see — a discount and a
  // processing fee, each already signed. Markup is NEVER among them: it is
  // folded into totalFare above and the server does not send it at all.
  lines?: { source: string; label: string; sign: -1 | 1; amount: number }[]
  // totalFare plus those lines. What they actually pay, before seat fees.
  sellTotal?: number
}

interface PolicyPreview {
  ok: boolean
  verdict?: 'green' | 'amber' | 'red'
  breaches?: { limit_key: string; kind: string; policyValue: unknown; actualValue: unknown }[]
  costTier?: string
  reason?: string
  message?: string
}

const VERDICT_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  green: { label: 'Within policy',       color: '#166534', bg: '#F0FDF4', border: '#BBF7D0' },
  amber: { label: 'Minor policy breach', color: '#92400E', bg: '#FFFBEB', border: '#FDE68A' },
  red:   { label: 'Policy breach',       color: '#991B1B', bg: '#FEF2F2', border: '#FECACA' },
}

const LIMIT_LABELS: Record<string, string> = {
  max_fare_domestic: 'domestic fare limit',
  max_fare_intl: 'international fare limit',
  advance_booking_days: 'minimum advance booking window',
  cabin_class_short_haul: 'cabin class entitlement (short-haul)',
  cabin_class_long_haul: 'cabin class entitlement (long-haul)',
  connecting_flights_allowed: 'connecting flights entitlement',
  max_seat_selection_fee: 'seat selection spend limit',
}

function breachLine(b: { limit_key: string; kind: string; policyValue: unknown; actualValue: unknown }): string {
  const label = LIMIT_LABELS[b.limit_key] ?? b.limit_key
  if (b.kind === 'boolean') return `${label} is not permitted for this employee`
  return `${label} exceeded (policy: ${b.policyValue}, actual: ${b.actualValue})`
}

function penaltySummary(lines: { paxType: string; text: string }[] | undefined): string | null {
  if (!lines || lines.length === 0) return null
  // Real responses show the same penalty text repeated per PaxType (ADT/CHD
  // both "INR3000", INF "0") far more often than genuinely different
  // amounts per type — collapsing to the adult figure keeps this readable
  // instead of listing three near-identical lines for a single-traveler
  // search. If they DO differ, showing all of them would be the more
  // correct choice, but that's not been seen in any real response yet.
  const adult = lines.find(l => l.paxType === 'ADT')
  const text = (adult ?? lines[0]).text?.trim()

  // Null, not a dash, and null for "Not Available" too.
  //
  // That string is the provider's own — it appears verbatim in real UAT
  // penalty blocks, meaning the fare rules were not returned, not that the fee
  // is zero or that cancellation is barred. Printing it fills a row with a
  // non-answer, and printing "—" is worse because it looks like a value. The
  // caller drops the row instead, and it reappears on its own the day the
  // provider starts sending real rules.
  if (!text || text.toLowerCase() === 'not available') return null
  return text
}

// The provider sends branded perks in shouting caps — "FREE CHECKED BAGGAGE
// ALLOWANCE", "PRE RESERVED SEAT ASSIGNMENT". Six of those stacked in a card
// is a wall. Only the casing is changed; the airline's own wording is kept,
// because this is a statement about what the ticket includes.
function sentenceCase(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase()
}

export default function SelectFarePage() {
  const router = useRouter()
  const params = useParams<{ flightKey: string }>()
  const flightKey = decodeURIComponent(params.flightKey)

  const [flight, setFlight] = useState<FlatFlightResult | null>(null)
  const [selectedFareIndex, setSelectedFareIndex] = useState(0)
  const [pricing, setPricing] = useState<PriceApiResult | null>(null)
  const [pricingLoading, setPricingLoading] = useState(true)
  const [error, setError] = useState('')
  const [continuing, setContinuing] = useState(false)
  // Keyed by fare option index — every card gets its own verdict so all of
  // them can show a border/banner at once, not just the selected one.
  const [verdicts, setVerdicts] = useState<Record<number, PolicyPreview>>({})

  useEffect(() => {
    const stored = flowStorage.findResultByFlightKey(flightKey)

    if (!stored) {
      // No flightKey → flight page-in-page workflow protection: this step
      // is only reachable by actually selecting a search result, never by
      // typing/bookmarking the URL directly. Redirect immediately rather
      // than rendering an error state the person has to click through.
      router.replace('/book/flights')
      return
    }

    setFlight(stored)
    runPricing(stored, 0)
    loadAllFareVerdicts(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightKey])

  // ── Policy preview, per fare option ─────────────────────────────────────
  // Uses each fare option's own search-time totalFare/refundable — NOT the
  // live-priced value — so this can run once for every card up front
  // without an extra real Amadeus Pricing call per option (runPricing only
  // prices the selected fare, on purpose, to avoid hammering the airline
  // for cards the traveler may never pick). This is a preview, same caveat
  // as everywhere else it's used: the authoritative verdict is recomputed
  // at add-passenger, against the actually-priced fare, right before a
  // bookings row is created.
  async function loadAllFareVerdicts(flightResult: FlatFlightResult) {
    const results = await Promise.all(
      flightResult.fareOptions.map(async (fare, i) => {
        try {
          const res = await fetch('/api/book/policy-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              flight: flightResult,
              totalFare: fare.totalFare ?? flightResult.totalFare ?? 0,
              isRefundable: fare.refundable ?? flightResult.refundable ?? false,
            }),
          })
          const data: PolicyPreview = await res.json()
          return [i, data] as const
        } catch {
          // Same as elsewhere: a preview failing shouldn't block the page.
          // That fare's card just won't show a border/banner.
          return [i, { ok: false }] as const
        }
      })
    )
    setVerdicts(Object.fromEntries(results))
  }

  async function runPricing(flightResult: FlatFlightResult, fareIndex: number) {
    setPricingLoading(true)
    setError('')

    const searchData = flowStorage.getSearchResults()
    const fareOption = flightResult.fareOptions[fareIndex] as FareOption | undefined
    const pricingKey = fareOption?.pricingKey ?? flightResult.pricingKey

    if (!searchData?.availabilityKey || !pricingKey) {
      setError('Missing pricing details for this flight — please search again.')
      setPricingLoading(false)
      return
    }

    try {
      const res = await fetch('/api/book/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: searchData.availabilityKey,
          pricingKey,
          provider: flightResult.provider,
          resultIndex: flightResult.itemNo,
          // The selected itinerary. Commercial rules match on category
          // (domestic/international × BSP/LCC), airline, cabin and booking
          // class — none of which can be read from a pricing key. Only the
          // ROUTE shape is taken from this; every figure is re-derived server
          // side from Amadeus's own response.
          itinerary: flightResult,
        }),
      })
      const data: PriceApiResult = await res.json()

      if (!data.ok) {
        setError(data.error || 'This fare is no longer available. Please select a different flight.')
        setPricing(null)
        return
      }

      setPricing(data)

      // Save the priced fare — the next step needs referenceNo, totalFare,
      // etc. and shouldn't have to re-price to get them.
      flowStorage.savePricedFare({
        flightKey: flightResult.flightKey,
        key: data.key!,
        pricingKey: pricingKey!,
        provider: flightResult.provider,
        resultIndex: flightResult.itemNo,
        referenceNo: data.referenceNo!,
        totalFare: data.totalFare!,
        baseFare: data.baseFare!,
        tax: data.tax!,
        lines: data.lines,
        // Falls back to totalFare when no commercial rule applies, so every
        // downstream reader can treat sellTotal as "the price" unconditionally.
        sellTotal: data.sellTotal ?? data.totalFare!,
        currency: data.currency!,
        isRefundable: data.isRefundable!,
        fareType: data.fareType!,
        // Prefer the live Pricing answer over the search row's — this is the
        // fare that was actually locked. The passengers page needs it to know
        // whether a special-meal request is one the airline will honour.
        mealIncluded: data.mealIncluded ?? fareOption?.mealIncluded,
        passengerBreakup: data.passengerBreakup,
        isNdc: fareOption?.isNdc ?? flightResult.isNdc,
        searchKey: searchData.availabilityKey ?? undefined,
      })
    } catch {
      setError('Something went wrong confirming this fare. Please try again.')
    } finally {
      setPricingLoading(false)
    }
  }

  function handleSelectFareOption(index: number) {
    if (!flight || index === selectedFareIndex) return
    setSelectedFareIndex(index)
    runPricing(flight, index)
  }

  function handleContinue() {
    setContinuing(true)
    router.push(`/book/details/${encodeURIComponent(flightKey)}`)
  }

  if (error && !flight) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <Link href="/book/flights" style={s.backLink}>← Back to results</Link>
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {error}</p>
            <Link href="/book/flights" style={s.errorLink}>← Search again</Link>
          </div>
        </div>
      </div>
    )
  }

  if (!flight) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.loadingCard}><div style={s.spinner} /></div>
        </div>
      </div>
    )
  }

  const hasMultipleFares = flight.fareOptions.length > 1
  const activeFare = flight.fareOptions[selectedFareIndex] as FareOption | undefined

  const journeys = journeysOf(flight)
  const hasReturn = journeys.length > 1

  // Baggage sits on the flight, not the fare, so it is built once rather than
  // per card. A row exists only where the provider gave an allowance — a
  // direction whose segments disagreed carries none, and says nothing.
  const baggageRows: string[] = journeys.flatMap(journey => {
    const where = hasReturn ? ` · ${journeyLabel(journey.journeyNo)}` : ''
    return [
      journey.cabinBaggageKg ? `${journey.cabinBaggageKg}kg cabin baggage${where}` : null,
      journey.checkInBaggageKg ? `${journey.checkInBaggageKg}kg check-in baggage${where}` : null,
    ].filter((row): row is string => row !== null)
  })

  // ── The rule detail for ONE fare ───────────────────────────────────────────
  // Rendered in exactly one place at a time: inside the card when this flight
  // offers a single fare (there is nothing to compare, so the card IS the
  // detail), and otherwise in the panel below the picker, for whichever fare is
  // selected.
  //
  // It used to render inside the selected CARD, which made that card roughly
  // three times the height of its neighbours and reflowed the whole row on
  // every click — the thing `alignSelf: flex-start` was added to paper over.
  // Choosing and reading are different jobs and now happen in different places.
  function fareDetailSections(fare: FareOption, mealsIncluded: boolean | undefined) {
    const changeText = penaltySummary(fare.changePenalties)
    const cancelText = penaltySummary(fare.cancelPenalties)
    const bases = fare.fareBases ?? (fare.fareBasis ? [{ journeyNo: 1, code: fare.fareBasis }] : [])

    return (
      <>
        {/* What this fare includes, in the airline's own words.
            brandedServices arrives as a pipe-delimited string and is already
            split by the search route. It is the only genuinely per-fare
            descriptive content the provider sends. */}
        {(fare.brandedServices?.length ?? 0) > 0 && (
          <div style={s.fareRuleSection}>
            <span style={s.fareRuleSectionTitle}>Included</span>
            {fare.brandedServices!.map((service, si) => (
              <div key={si} style={s.fareRuleLine}>
                <span style={s.fareRuleDot} />{sentenceCase(service)}
              </div>
            ))}
          </div>
        )}

        {/* Baggage is per DIRECTION, not per fare — it is filed on the
            itinerary and has no per-fare node at all. Labelled by direction
            only when there is more than one. */}
        {baggageRows.length > 0 && (
          <div style={s.fareRuleSection}>
            <span style={s.fareRuleSectionTitle}>Baggage</span>
            {baggageRows.map((row, bi) => (
              <div key={bi} style={s.fareRuleLine}><span style={s.fareRuleDot} />{row}</div>
            ))}
          </div>
        )}

        {/* Every row here is conditional. The provider returns "Not Available"
            for penalties in UAT, which means the fare rules were not sent —
            not that the fee is zero. A row exists when there is something true
            to put in it, so nothing here is a placeholder a traveller could
            mistake for a term of their ticket. */}
        {(cancelText || changeText || bases.length > 0) && (
          <div style={s.fareRuleSection}>
            <span style={s.fareRuleSectionTitle}>Flexibility</span>
            {cancelText && (
              <div style={s.fareRuleLine}><span style={s.fareRuleDotAmber} />Cancellation fee {cancelText}</div>
            )}
            {changeText && (
              <div style={s.fareRuleLine}><span style={s.fareRuleDotAmber} />Date change fee {changeText}</div>
            )}
            {/* One code per direction. A round trip prices each way under its
                own basis, and showing only the first hid the return's. */}
            {bases.map(fb => (
              <div key={fb.journeyNo} style={s.fareRuleLine}>
                <span style={s.fareRuleDot} />
                Fare basis {fb.code}
                {hasReturn && <span style={s.fareRuleAside}> · {journeyLabel(fb.journeyNo)}</span>}
              </div>
            ))}
          </div>
        )}

        <div style={s.fareRuleSection}>
          <span style={s.fareRuleSectionTitle}>Meals</span>
          <div style={s.fareRuleLine}>
            <span style={mealsIncluded ? s.fareRuleDot : s.fareRuleDotAmber} />
            {mealsIncluded ? 'Complimentary meal' : 'Meals — optional, at extra cost'}
          </div>
        </div>
      </>
    )
  }

  // The fare the detail panel describes, and the policy verdict against it.
  const selectedVerdict = verdicts[selectedFareIndex]
  const selectedVerdictColor = selectedVerdict?.ok && selectedVerdict.verdict
    ? VERDICT_META[selectedVerdict.verdict]
    : null
  // Once priced, the live response is the better answer than the search row.
  const selectedMealsIncluded = pricing ? pricing.mealIncluded : activeFare?.mealIncluded

  return (
    <div style={s.page}>
      <div style={s.root}>
        <Link href="/book/flights" style={s.backLink}>← Back to results</Link>

        <div style={s.header}>
          <h1 style={s.heading}>Select your fare</h1>
          <p style={s.sub}>Review the fare details, then confirm to lock in the live price.</p>
        </div>

        {/* ── Flight summary — available instantly, no API call ─────── */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={s.airlineBlock}>
              <div style={s.airlineAvatar}>{flight.airline?.name?.[0] ?? '✈'}</div>
              <div>
                <div style={s.airlineName}>{flight.airline?.name ?? 'Unknown airline'}</div>
                <div style={s.airlineMeta}>
                  {flight.airline?.code} · {flight.cabin ?? 'Economy'}
                  {(activeFare?.isNdc ?? flight.isNdc) && <span style={s.ndcTag}>NDC fare</span>}
                </div>
              </div>
            </div>
          </div>

          {journeys.map(journey => (
            <div key={journey.journeyNo}>
              {hasReturn && <span style={s.journeyLabel}>{journeyLabel(journey.journeyNo)}</span>}
              <div style={s.routeRow}>
                <div style={s.routePoint}>
                  <span style={s.routeTime}>{formatTime(journey.origin?.dateTime)}</span>
                  <span style={s.routeCode}>{journey.origin?.code}</span>
                  {journey.origin?.terminal && <span style={s.routeTerminal}>Terminal {journey.origin.terminal}</span>}
                  <span style={s.routeDay}>{formatDayLabel(journey.origin?.dateTime)}</span>
                </div>
                <div style={s.routeMiddle}>
                  <span style={s.routeDuration}>{journey.totalDuration ?? journey.duration ?? ''}</span>
                  <div style={s.routeLine} />
                  <span style={s.routeStops}>
                    {journey.stopCount === 0 ? 'Non-stop' : journey.stops.map(st => `via ${st.city}`).join(', ')}
                  </span>
                </div>
                <div style={{ ...s.routePoint, alignItems: 'flex-end' as const }}>
                  <span style={s.routeTime}>{formatTime(journey.destination?.dateTime)}</span>
                  <span style={s.routeCode}>{journey.destination?.code}</span>
                  {journey.destination?.terminal && <span style={s.routeTerminal}>Terminal {journey.destination.terminal}</span>}
                  <span style={s.routeDay}>{formatDayLabel(journey.destination?.dateTime)}</span>
                </div>
              </div>
            </div>
          ))}

          <div style={s.metaTags}>
            <span style={{ ...s.tag, ...(flight.isLcc ? s.tagBudget : s.tagFullService) }}>
              {flight.isLcc ? 'Budget carrier' : 'Full-service'}
            </span>
            {flight.availableSeats != null && <span style={s.tag}>{flight.availableSeats} seats left</span>}
          </div>
        </div>

        {/* ── Fare options — one rich card per option, price + grouped ── */}
        {/* rule sections (Baggage / Flexibility / Seats, Meals & More),   */}
        {/* matching the structure of a standard OTA fare-comparison card. */}
        {/* When there's only one fare option (the common case today —    */}
        {/* confirmed real responses never show more than one), it still  */}
        {/* renders as a single full card, not a disabled picker.         */}
        <h2 style={s.cardTitle}>{hasMultipleFares ? 'Choose a fare' : 'Fare details'}</h2>
        {/* Said once, here, rather than once per card. It was a hardcoded line
            inside every fare card, identical on all of them, describing the
            NEXT step rather than the fare it sat in — so on a six-fare flight
            it was six copies of a sentence that distinguished nothing. */}
        <p style={s.cardSub}>Seats are chargeable and selected on the next step.</p>
        <div style={hasMultipleFares ? s.fareOptionScroller : s.fareOptionList}>
            {flight.fareOptions.map((fare, i) => {
              const isActive = i === selectedFareIndex
              const mealsIncluded = pricing && isActive ? pricing.mealIncluded : fare.mealIncluded
              // The airline's own name for this fare product — "ECO VALUE",
              // "ECO FLEX". This is what actually distinguishes one fare from
              // another on a flight that offers six of them; fareType (NRM/CRP)
              // is a refundability class that repeats across tiers, so cards
              // titled by it read as identical.
              const fareTitle = fare.brandedFareDescription || fare.brandedFareName || fare.fareType || `Fare ${i + 1}`
              const fareVerdict = verdicts[i]
              const verdictColor = fareVerdict?.ok && fareVerdict.verdict ? VERDICT_META[fareVerdict.verdict] : null

              // A single-fare flight is not a comparison at all, so its one card
              // carries the full detail. With several to choose between, every
              // card stays the same compact size and the detail for the selected
              // one renders in the panel below.
              const showDetail = !hasMultipleFares

              // The gist, built only from what the provider actually sent — so
              // it stays empty rather than inventing reassurance when a fare
              // carries no branded data.
              const summaryBits = [
                journeys[0]?.checkInBaggageKg ? `${journeys[0].checkInBaggageKg}kg check-in` : null,
                mealsIncluded ? 'Meal included' : null,
                (fare.brandedServices?.length ?? 0) > 0
                  ? `${fare.brandedServices!.length} inclusion${fare.brandedServices!.length === 1 ? '' : 's'}`
                  : null,
              ].filter(Boolean) as string[]

              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleSelectFareOption(i)}
                  style={{
                    ...s.fareCard,
                    ...(isActive ? s.fareCardActive : {}),
                    ...(hasMultipleFares ? s.fareCardScrollItem : s.fareCardStatic),
                    ...(verdictColor ? { borderColor: verdictColor.border, borderWidth: '2px' } : {}),
                  }}
                >
                  <div style={s.fareCardTopRow}>
                    {/* Title on its own line and allowed to truncate. It shared
                        a line with the refundability pill at 232px wide, so
                        "ECO CLASSIC" + "Non-refundable" wrapped mid-word and
                        every card ended up a different height. */}
                    <span style={s.fareCardType}>{fareTitle}</span>
                    {hasMultipleFares && (
                      <div style={s.fareOptionRadio}>
                        <div style={{ ...s.fareOptionRadioDot, ...(isActive ? s.fareOptionRadioDotActive : {}) }} />
                      </div>
                    )}
                  </div>

                  <div style={s.fareCardPriceRow}>
                    <span style={s.fareCardPrice}>{fare.currency} {fare.totalFare?.toLocaleString('en-IN')}</span>
                    <span style={s.fareCardPriceSub}>per adult</span>
                  </div>

                  <div style={s.fareCardTagRow}>
                    <span style={{ ...s.fareOptionRefundTag, color: fare.refundable ? '#166534' : '#9CA3AF', background: fare.refundable ? '#F0FDF4' : '#F3F4F6' }}>
                      {fare.refundable ? 'Refundable' : 'Non-refundable'}
                    </span>
                    {/* The policy verdict as a chip rather than a banner with a
                        breach list. The list is genuinely useful and genuinely
                        variable-length — it belongs in the panel below, where it
                        cannot stretch one card past its neighbours. */}
                    {verdictColor && (
                      <span style={{ ...s.fareVerdictChip, color: verdictColor.color, background: verdictColor.bg, borderColor: verdictColor.border }}>
                        <span style={{ ...s.fareVerdictDot, background: verdictColor.color }} />
                        {verdictColor.label}
                      </span>
                    )}
                  </div>

                  {summaryBits.length > 0 && (
                    <p style={s.fareSummaryLine}>{summaryBits.join(' · ')}</p>
                  )}

                  {showDetail && fareDetailSections(fare, mealsIncluded)}
                </button>
              )
            })}
        </div>

        {/* ── The selected fare's rules, once, full width ─────────────────────
            Laid out in columns so four short sections read as one block rather
            than as a long scroll — the complaint that started this. */}
        {hasMultipleFares && activeFare && (
          <div style={s.fareDetailPanel}>
            <div style={s.fareDetailHead}>
              <span style={s.fareDetailTitle}>
                {activeFare.brandedFareDescription || activeFare.brandedFareName || activeFare.fareType || `Fare ${selectedFareIndex + 1}`}
              </span>
              <span style={s.fareDetailSub}>What this fare includes</span>
            </div>

            {selectedVerdictColor && (
              <div style={{ ...s.fareVerdictBanner, background: selectedVerdictColor.bg, borderColor: selectedVerdictColor.border }}>
                <div style={s.fareVerdictHeader}>
                  <span style={{ ...s.fareVerdictDot, background: selectedVerdictColor.color }} />
                  <span style={{ ...s.fareVerdictLabel, color: selectedVerdictColor.color }}>{selectedVerdictColor.label}</span>
                </div>
                {(selectedVerdict!.breaches?.length ?? 0) > 0 && (
                  <ul style={s.fareVerdictList}>
                    {selectedVerdict!.breaches!.map((b, bi) => (
                      <li key={bi} style={{ ...s.fareVerdictListItem, color: selectedVerdictColor.color }}>
                        {breachLine(b)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div style={s.fareDetailColumns}>
              {fareDetailSections(activeFare, selectedMealsIncluded)}
            </div>
          </div>
        )}

        {/* ── Fare breakdown — live from Pricing ──────────────────────── */}
        <div style={s.card}>
          <h2 style={s.cardTitle}>Fare breakdown</h2>

          {pricingLoading && (
            <div style={s.pricingLoadingRow}>
              <div style={s.spinnerSmall} />
              <span style={s.pricingLoadingText}>Confirming live price with the airline…</span>
            </div>
          )}

          {!pricingLoading && error && (
            <div style={s.inlineError}>
              <p style={s.inlineErrorText}>⚠ {error}</p>
            </div>
          )}

          {!pricingLoading && !error && pricing?.ok && (
            <>
              <div style={s.fareRow}>
                <span style={s.fareLabel}>Base fare</span>
                <span style={s.fareValue}>{pricing.currency} {pricing.baseFare?.toLocaleString('en-IN')}</span>
              </div>
              <div style={s.fareRow}>
                <span style={s.fareLabel}>Taxes & fees</span>
                <span style={s.fareValue}>{pricing.currency} {pricing.tax?.toLocaleString('en-IN')}</span>
              </div>

              {/* Discount and processing fee, each on its own line. The server
                  sends only the lines a traveller is allowed to see — a markup
                  is folded into the fare above and is not in this array,
                  because anything sent is visible in devtools. */}
              {(pricing.lines ?? []).map(line => (
                <div key={line.source} style={s.fareRow}>
                  <span style={s.fareLabel}>{line.label}</span>
                  <span style={{ ...s.fareValue, ...(line.sign === -1 ? s.fareCredit : {}) }}>
                    {line.sign === -1 ? '− ' : '+ '}
                    {pricing.currency} {line.amount.toLocaleString('en-IN')}
                  </span>
                </div>
              ))}

              <div style={{ ...s.fareRow, ...s.fareRowTotal }}>
                <span style={s.fareTotalLabel}>Total fare</span>
                <span style={s.fareTotalValue}>
                  {pricing.currency} {(pricing.sellTotal ?? pricing.totalFare)?.toLocaleString('en-IN')}
                </span>
              </div>

              {pricing.passengerBreakup && pricing.passengerBreakup.length > 1 && (
                <div style={s.paxBreakup}>
                  <p style={s.paxBreakupTitle}>Per passenger</p>
                  {pricing.passengerBreakup.map((pax, i) => (
                    <div key={i} style={s.paxRow}>
                      <span style={s.paxType}>{pax.PaxType}</span>
                      <span style={s.paxFare}>{pricing.currency} {pax.TotalFare?.toLocaleString('en-IN')}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={s.fareTags}>
                <span style={{ ...s.tag, color: pricing.isRefundable ? '#065F46' : '#9CA3AF', background: pricing.isRefundable ? '#ECFDF5' : '#F3F4F6' }}>
                  {pricing.isRefundable ? 'Refundable' : 'Non-refundable'}
                </span>
                {pricing.fareType && <span style={s.tag}>{pricing.fareType}</span>}
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={handleContinue}
          disabled={continuing || pricingLoading || !pricing?.ok}
          style={{ ...s.continueBtn, opacity: (continuing || pricingLoading || !pricing?.ok) ? 0.6 : 1 }}
        >
          {continuing ? 'Opening…' : 'Select this fare →'}
        </button>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '1040px', margin: '0 auto', padding: '32px 24px 64px' },

  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  spinnerSmall: { width: '16px', height: '16px', border: '2px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 10px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },

  inlineError: { padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px' },
  inlineErrorText: { fontSize: '12.5px', color: '#DC2626', margin: 0 },

  pricingLoadingRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0' },
  pricingLoadingText: { fontSize: '12.5px', color: '#6B7280' },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '16px' },
  cardHeader: { marginBottom: '14px' },
  cardTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 16px' },

  airlineBlock: { display: 'flex', alignItems: 'center', gap: '10px' },
  airlineAvatar: { width: '34px', height: '34px', borderRadius: '9px', background: '#EEF2FF', color: '#3730A3', fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  airlineName: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  airlineMeta: { fontSize: '11px', color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' },
  ndcTag: { fontSize: '9px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '1px 6px', borderRadius: '4px', letterSpacing: '0.3px' },

  routeRow: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '14px', padding: '14px 0', borderTop: '1px solid #F3F4F6', borderBottom: '1px solid #F3F4F6' },
  journeyLabel: { display: 'block', fontSize: '11px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', marginTop: '10px' },
  routePoint: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '0 0 auto', minWidth: '58px' },
  routeTime: { fontSize: '16px', fontWeight: 700, color: '#111827' },
  routeCode: { fontSize: '11px', fontWeight: 600, color: '#6B7280' },
  routeTerminal: { fontSize: '9.5px', color: '#9CA3AF' },
  routeDay: { fontSize: '10px', color: '#9CA3AF' },
  routeMiddle: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
  routeDuration: { fontSize: '10px', color: '#9CA3AF', fontWeight: 500 },
  routeLine: { width: '100%', height: '1px', background: '#D1D5DB' },
  routeStops: { fontSize: '10px', color: '#9CA3AF' },

  metaTags: { display: 'flex', gap: '6px', flexWrap: 'wrap' as const },
  tag: { fontSize: '10px', color: '#6B7280', background: '#F3F4F6', padding: '3px 9px', borderRadius: '5px', fontWeight: 500 },
  tagBudget: { color: '#7C2D12', background: '#FFF7ED' },
  tagFullService: { color: '#14532D', background: '#F0FDF4' },

  fareOptionList: { display: 'flex', flexDirection: 'column' as const, gap: '12px' },
  // Multiple fares: horizontal scroller, fixed-width cards, snaps into
  // view per-card. Single fare falls back to fareOptionList above — one
  // full-width card, no scroller chrome for a one-option flight.
  fareOptionScroller: {
    display: 'flex', flexDirection: 'row' as const, gap: '10px', overflowX: 'auto' as const,
    // alignItems: stretch (the flex default, stated here because it is load-
    // bearing) is what makes every card exactly the same height now that none
    // of them can grow: the tallest content sets the height and the rest match.
    alignItems: 'stretch' as const,
    padding: '4px 16px 10px 0', scrollSnapType: 'x proximity' as const, WebkitOverflowScrolling: 'touch' as const,
  },
  fareCard: {
    display: 'flex', flexDirection: 'column' as const, width: '100%',
    padding: '11px 12px', background: '#F9FAFB', border: '1.5px solid #E5E7EB', borderRadius: '10px',
    cursor: 'pointer', textAlign: 'left' as const,
  },
  fareCardActive: { background: '#EEF2FF', borderColor: '#000835' },
  fareCardStatic: { cursor: 'default' },
  // Every card now holds the same four things — name, price, tags, one gist
  // line — so they are the same size by construction rather than by being
  // stopped from stretching. `alignSelf: flex-start` used to live here for that
  // reason and is gone: it was the workaround for the selected card expanding
  // inline, and with the detail moved to its own panel the row wants the
  // opposite behaviour.
  fareCardScrollItem: { width: '196px', flexShrink: 0, scrollSnapAlign: 'start' as const },
  fareSummaryLine: { fontSize: '11px', color: '#6B7280', margin: '7px 0 0', lineHeight: 1.45 },
  fareCardTopRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px', marginBottom: '5px' },
  fareCardTagRow: { display: 'flex', flexWrap: 'wrap' as const, gap: '5px' },

  // ── The selected fare's rules ──────────────────────────────────────────────
  fareDetailPanel: {
    marginTop: '-2px', marginBottom: '18px', padding: '14px 16px',
    background: '#FFFFFF', border: '1.5px solid #E5E7EB', borderRadius: '12px',
  },
  fareDetailHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' as const, marginBottom: '10px' },
  fareDetailTitle: { fontSize: '13px', fontWeight: 700, color: '#111827' },
  fareDetailSub: { fontSize: '11.5px', color: '#9CA3AF' },
  // Four short sections side by side instead of stacked. auto-fit collapses to
  // one column on a narrow screen without a media query, which this file cannot
  // express anyway — every style here is an inline object.
  fareDetailColumns: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(184px, 1fr))',
    gap: '4px 20px', alignItems: 'start' as const,
  },

  fareVerdictBanner: { border: '1px solid', borderRadius: '10px', padding: '10px 12px', margin: '10px 0' },
  fareVerdictHeader: { display: 'flex', alignItems: 'center', gap: '7px' },
  fareVerdictDot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  fareVerdictLabel: { fontSize: '12px', fontWeight: 700 },
  fareVerdictList: { margin: '6px 0 0', paddingLeft: '16px', display: 'flex', flexDirection: 'column' as const, gap: '3px' },
  fareVerdictListItem: { fontSize: '11px', lineHeight: 1.5, textAlign: 'left' as const },
  // Truncates rather than wraps. A two-line title on one card and a one-line
  // title on the next is the difference in height that made the row look ragged
  // even before the selected card expanded.
  fareCardType: {
    fontSize: '12px', fontWeight: 700, color: '#111827', lineHeight: 1.3,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0,
  },
  fareOptionRefundTag: { fontSize: '9.5px', fontWeight: 700, padding: '3px 7px', borderRadius: '5px', whiteSpace: 'nowrap' as const },
  fareVerdictChip: {
    display: 'inline-flex', alignItems: 'center', gap: '5px',
    fontSize: '9.5px', fontWeight: 700, padding: '3px 7px', borderRadius: '5px',
    border: '1px solid', whiteSpace: 'nowrap' as const,
  },
  fareOptionRadio: { width: '18px', height: '18px', borderRadius: '50%', border: '2px solid #D1D5DB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  fareOptionRadioDot: { width: '8px', height: '8px', borderRadius: '50%', background: 'transparent' },
  fareOptionRadioDotActive: { background: '#000835' },

  fareCardPriceRow: { display: 'flex', alignItems: 'baseline', gap: '4px', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px dashed #E5E7EB' },
  fareCardPrice: { fontSize: '15.5px', fontWeight: 700, color: '#0A0A14', whiteSpace: 'nowrap' as const },
  fareCardPriceSub: { fontSize: '10px', color: '#9CA3AF' },

  fareRuleSection: { marginBottom: '9px' },
  fareRuleSectionTitle: { display: 'block', fontSize: '10px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', marginBottom: '4px' },
  fareRuleLine: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '11.5px', color: '#374151', padding: '2px 0' },
  fareRuleDot: { width: '6px', height: '6px', borderRadius: '50%', background: '#22C55E', flexShrink: 0 },
  // The direction a row belongs to, on a round trip only.
  fareRuleAside: { color: '#9CA3AF' },
  cardSub: { margin: '0 0 12px', fontSize: '12.5px', color: '#6B7280' },
  fareRuleDotAmber: { width: '6px', height: '6px', borderRadius: '50%', background: '#F59E0B', flexShrink: 0 },

  fareRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' },
  fareLabel: { fontSize: '13px', color: '#6B7280' },
  fareValue: { fontSize: '13px', color: '#111827', fontWeight: 500 },
  // A reduction reads green, so a discount is legible as a benefit rather than
  // as one more number in a column.
  fareCredit: { color: '#166534' },
  fareRowTotal: { borderTop: '1px solid #F3F4F6', marginTop: '4px', paddingTop: '12px' },
  fareTotalLabel: { fontSize: '14px', fontWeight: 700, color: '#111827' },
  fareTotalValue: { fontSize: '18px', fontWeight: 700, color: '#0A0A14' },

  paxBreakup: { marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed #E5E7EB' },
  paxBreakupTitle: { fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', margin: '0 0 8px' },
  paxRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px' },
  paxType: { color: '#6B7280' },
  paxFare: { color: '#111827', fontWeight: 500 },

  fareTags: { display: 'flex', gap: '6px', marginTop: '14px' },

  continueBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}