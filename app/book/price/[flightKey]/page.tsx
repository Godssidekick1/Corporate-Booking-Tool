'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import AirlineMark from '@/app/components/AirlineMark'
import Link from 'next/link'
import { flowStorage } from '@/app/lib/book/flowStorage'
import { useResultsHref } from '@/app/components/book/search/useResultsHref'
import { ButtonBusy } from '@/app/components/FlowLoader'
import { breachLine } from '@/app/lib/policy/breachText'
import { VERDICT_META } from '@/app/lib/policy/verdictLabels'
import DeskFareStrip from '@/app/components/book/DeskFareStrip'
import FareRulesPanel from '@/app/components/book/FareRulesPanel'
import FareRow, { fareName } from '@/app/components/book/FareRow'
import lay from '../FarePage.module.css'
import { defaultFare } from '@/app/lib/book/resultFilters'
import type { FareRules } from '@/app/lib/book/fareRules'
import type { DeskView } from '@/app/lib/commercials/deskView'
import {
  FlatFlightResult, FareOption, formatTime, formatDayLabel, journeysOf, journeyLabel,
  baggageLabel,
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
  // The travel desk only: how the price is made (never sent to anyone else).
  desk?: DeskView | null
  // The airline's cancellation and change rules for this fare; null when it
  // sent none.
  fareRules?: FareRules | null
}

interface PolicyPreview {
  ok: boolean
  verdict?: 'green' | 'amber' | 'red'
  breaches?: { limit_key: string; kind: string; policyValue: unknown; actualValue: unknown; graceLimit?: number }[]
  reason?: string
  message?: string
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
  const resultsHref = useResultsHref()
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

    // The fare chosen on the results card (?fare=<pricingKey>), else the first.
    // Read once from the URL here rather than through useSearchParams: only
    // the first render needs it, and a refresh keeps it.
    const wanted = new URLSearchParams(window.location.search).get('fare')
    // The fare asked for, else the one a flight starts with (cheapest within
    // policy, else cheapest): the results continue here without choosing.
    const wantedIndex = stored.fareOptions.findIndex(f => f.pricingKey === wanted)
    const startFare = defaultFare(stored)
    const startIndex = wantedIndex >= 0 ? wantedIndex : Math.max(0, stored.fareOptions.findIndex(f => f === startFare))
    setFlight(stored)
    setSelectedFareIndex(startIndex)
    runPricing(stored, startIndex)
    loadAllFareVerdicts(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightKey])

  // ── Policy preview, per fare option ─────────────────────────────────────
  // Judges each fare by what the company would pay for it (its search-time
  // sellEstimate: fare less discount plus fee), the same figure the details
  // page and add-passenger judge. It once sent the fare before discount and
  // fee, so a well-discounted fare read "out of policy" here and "within" one
  // step later. This runs once for every card up front without a real Pricing
  // call per option (runPricing prices only the selected fare, so the airline
  // is not hammered for cards the traveller may never pick); once the
  // selected fare is priced, its card is judged again on the priced figure
  // (judgeFare below). The authoritative verdict is still add-passenger's.
  async function judgeFare(flightResult: FlatFlightResult, fare: FareOption | undefined, sellTotal: number | undefined): Promise<PolicyPreview> {
    if (typeof sellTotal !== 'number') return { ok: false }
    try {
      const res = await fetch('/api/book/policy-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          travellerId: flowStorage.travellerId(),
          flight: flightResult,
          sellTotal,
          isRefundable: fare?.refundable ?? flightResult.refundable ?? false,
          cancelPenalties: fare?.cancelPenalties,
          // The search it came from, for the lowest logical fare: the same
          // check the next pages run.
          searchKey: flowStorage.availabilityKeyFor(flightResult.flightKey) ?? undefined,
          pricingKey: fare?.pricingKey ?? flightResult.pricingKey,
        }),
      })
      return await res.json()
    } catch {
      // Same as elsewhere: a preview failing shouldn't block the page.
      // That fare's card just won't show a border/banner.
      return { ok: false }
    }
  }

  async function loadAllFareVerdicts(flightResult: FlatFlightResult) {
    const results = await Promise.all(
      flightResult.fareOptions.map(async (fare, i) =>
        [i, await judgeFare(flightResult, fare, fare.sellEstimate ?? fare.totalFare ?? flightResult.totalFare)] as const)
    )
    // Merged, not replaced: a priced fare's verdict may already have arrived.
    setVerdicts(prev => ({ ...Object.fromEntries(results), ...prev }))
  }

  async function runPricing(flightResult: FlatFlightResult, fareIndex: number) {
    setPricingLoading(true)
    setError('')

    // The key of the search this flight came from (a round trip's columns are
    // separate searches, each with its own).
    const availabilityKey = flowStorage.availabilityKeyFor(flightResult.flightKey)
    const fareOption = flightResult.fareOptions[fareIndex] as FareOption | undefined
    const pricingKey = fareOption?.pricingKey ?? flightResult.pricingKey

    if (!availabilityKey || !pricingKey) {
      setError('Missing pricing details for this flight — please search again.')
      setPricingLoading(false)
      return
    }

    try {
      const res = await fetch('/api/book/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Booking for someone else: whose (bookingActor); absent = oneself.
          travellerId: flowStorage.travellerId(),
          key: availabilityKey,
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

      // The selected card judged on the priced figure: the airline may have
      // moved the fare since search, and this is what the next page judges.
      const pricedSell = data.sellTotal ?? data.totalFare
      judgeFare(flightResult, fareOption, pricedSell).then(v => {
        if (v.ok) setVerdicts(prev => ({ ...prev, [fareIndex]: v }))
      })

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
        cancelPenalties: data.cancelPenalties,
        desk: data.desk ?? undefined,
        pricedAt: Date.now(),
        isNdc: fareOption?.isNdc ?? flightResult.isNdc,
        searchKey: availabilityKey ?? undefined,
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
          <Link href={resultsHref} style={s.backLink}>← Back to results</Link>
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
    // Weight or pieces, whichever the fare filed. These hardcoded "kg", which
    // turned a piece-based international allowance into "0kg check-in baggage".
    const cabin = baggageLabel(journey.cabinBaggageKg, journey.cabinBaggagePieces)
    const checkIn = baggageLabel(journey.checkInBaggageKg, journey.checkInBaggagePieces)
    return [
      cabin ? `${cabin} cabin baggage${where}` : null,
      checkIn ? `${checkIn} check-in baggage${where}` : null,
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
    // The airline's full rules, once priced, say more than the one-line fees:
    // shown in their own panel, so the lines here would only repeat them.
    const rulesShown = fare === activeFare && !pricingLoading && !!pricing?.fareRules?.sectors.length
    const changeText = rulesShown ? null : penaltySummary(fare.changePenalties)
    const cancelText = rulesShown ? null : penaltySummary(fare.cancelPenalties)
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
      <div className={lay.root}>
        <Link href={resultsHref} style={s.backLink}>← Back to results</Link>

        <div style={s.header}>
          <h1 style={s.heading}>Select your fare</h1>
          <p style={s.sub}>Review the fare details, then confirm to lock in the live price.</p>
        </div>

        <div className={lay.layout}>
        <div className={lay.main}>

        {/* ── Flight summary — available instantly, no API call ─────── */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={s.airlineBlock}>
              <AirlineMark code={flight.airline?.code ?? flight.legs?.[0]?.airlineCode} name={flight.airline?.name} />
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
        <div style={s.fareRowWrap}>
          <FareRow
            flight={flight} label="Fares on this flight"
            selectedKey={activeFare?.pricingKey ?? null}
            caption={hasMultipleFares ? `${flight.fareOptions.length} fares on this flight` : 'The fare on this flight'}
            // Each fare as judged here (the sell price, priced), else as search judged it.
            verdictOf={(fare, i) => (verdicts[i]?.ok ? verdicts[i].verdict : fare.policy)}
            mealOf={(fare, i) => (pricing && i === selectedFareIndex ? pricing.mealIncluded : fare.mealIncluded)}
            onPick={(_, i) => handleSelectFareOption(i)}
          />
        </div>

        {/* ── The selected fare's rules, once, full width ─────────────────────
            Laid out in columns so four short sections read as one block rather
            than as a long scroll — the complaint that started this. */}
        {activeFare && (
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

        {/* ── The airline's fare rules for the chosen fare ───────────────
            Fetched with the live price: cancellation and change charges by
            how long before departure, and no-show. */}
        {activeFare && (pricingLoading || pricing?.ok) && (
          <FareRulesPanel rules={pricing?.fareRules} loading={pricingLoading} compact />
        )}

        </div>

        {/* ── The price summary, in view while the fares and rules scroll ── */}
        <aside className={lay.side} aria-label="Price summary">
        <div style={{ ...s.card, marginBottom: 0 }}>
          <h2 style={s.cardTitle}>Price summary</h2>
          {activeFare && (
            <div style={s.summaryFare}>
              <span style={s.summaryFareLabel}>Your fare</span>
              <b>{flight.airline?.name ?? flight.airline?.code} · {fareName(activeFare, selectedFareIndex)}</b>
              <span style={s.summaryFareRoute}>
                {journeys[0]?.origin?.code} → {journeys[0]?.destination?.code}{hasReturn ? ' and back' : ''} · {formatDayLabel(journeys[0]?.origin?.dateTime)}
              </span>
            </div>
          )}

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
              {/* "Taxes & surcharges", because it now includes the fuel
                  surcharge. It previously showed OtherTax alone, which left the
                  three rows on this card visibly failing to add up. */}
              <div style={s.fareRow}>
                <span style={s.fareLabel}>Taxes & surcharges</span>
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

              <DeskFareStrip desk={pricing.desk} currency={pricing.currency} />

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

              {selectedVerdictColor && (
                <div style={{ ...s.summaryVerdict, color: selectedVerdictColor.color, background: selectedVerdictColor.bg, borderColor: selectedVerdictColor.border }}>
                  <span style={{ ...s.fareVerdictDot, background: selectedVerdictColor.color }} />{selectedVerdictColor.label}
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
          {/* Inline, not an overlay. This one only navigates — the passenger
              page does its own loading on arrival, and taking the screen away
              for a route change would be a heavier signal than the wait
              deserves. The overlay is kept for the two steps that call the
              airline. */}
          {continuing ? <ButtonBusy label="Opening…" /> : 'Select this fare →'}
        </button>
        </aside>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  // The loading and error states; the page itself uses FarePage.module.css.
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '1320px', margin: '0 auto', padding: '28px max(16px, 2vw) 64px' },

  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '24px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '14px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

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
  cardTitle: { fontSize: '15px', fontWeight: 600, color: '#111827', margin: '0 0 16px' },

  airlineBlock: { display: 'flex', alignItems: 'center', gap: '10px' },
  airlineAvatar: { width: '34px', height: '34px', borderRadius: '9px', background: '#EEF2FF', color: '#3730A3', fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  airlineName: { fontSize: '14.5px', fontWeight: 600, color: '#111827' },
  airlineMeta: { fontSize: '11px', color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' },
  ndcTag: { fontSize: '9px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '1px 6px', borderRadius: '4px', letterSpacing: '0.3px' },

  routeRow: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '14px', padding: '14px 0', borderTop: '1px solid #F3F4F6', borderBottom: '1px solid #F3F4F6' },
  journeyLabel: { display: 'block', fontSize: '11px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.4px', marginTop: '10px' },
  routePoint: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '0 0 auto', minWidth: '58px' },
  routeTime: { fontSize: '19px', fontWeight: 700, color: '#111827' },
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


  // The fares, in one row that scrolls sideways (FareRow).
  fareRowWrap: { background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '16px 16px 8px', marginBottom: '14px' },

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
  fareTotalValue: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', letterSpacing: '-0.3px' },

  summaryFare: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '13.5px', color: '#111827', paddingBottom: '12px', marginBottom: '6px', borderBottom: '1px solid #F3F4F6' },
  summaryFareLabel: { fontSize: '10.5px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.5px' },
  summaryFareRoute: { fontSize: '12.5px', color: '#6B7280' },
  summaryVerdict: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', fontSize: '13px', fontWeight: 600, border: '1px solid', borderRadius: '10px', padding: '9px 12px' },

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