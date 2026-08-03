'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { flowStorage } from '@/app/lib/book/flowStorage'
import { FlatFlightResult, LegSeatMap, SeatCell, SelectedSeat } from '@/app/lib/book/types'

// ── /book/seats/[flightKey] ───────────────────────────────────────────────────
// Sits right after Price, before passenger details, in the booking chain
// (search → price → seats → passengers → add-passenger → book → ticket).
//
// One /api/book/seatmap call per leg (origin -> each stop -> destination),
// same as the airline's own SeatMap endpoint is scoped. Seat selection is
// entirely optional — a traveler can skip it for any or all legs and simply
// travel without a pre-assigned seat.
//
// Selections are keyed by passenger index and stored via flowStorage, then
// picked up by the passengers page and folded into each
// PassengerDetails[i].SeatListDetails on submit.
// ─────────────────────────────────────────────────────────────────────────────

interface LegInfo {
  legIndex: number
  origin: string
  destination: string
}

function buildLegs(flight: FlatFlightResult): LegInfo[] {
  if (!flight.origin?.code || !flight.destination?.code) return []
  const points = [flight.origin.code, ...flight.stops.map(s => s.code), flight.destination.code]
  return points.slice(0, -1).map((origin, i) => ({ legIndex: i, origin, destination: points[i + 1] }))
}

// Groups a flat seat list back into rows for rendering, splitting each row
// into a left block and right block around the natural aisle gap — works for
// both 3-3 (6 real seats/row) and other layouts since it just splits down
// the middle of however many real seats survived filtering.
function groupByRow(seats: SeatCell[]): Map<number, SeatCell[]> {
  const rows = new Map<number, SeatCell[]>()
  for (const seat of seats) {
    const list = rows.get(seat.rowNo) ?? []
    list.push(seat)
    rows.set(seat.rowNo, list)
  }
  return rows
}

function splitRow(rowSeats: SeatCell[]): { left: SeatCell[]; right: SeatCell[] } {
  const mid = Math.ceil(rowSeats.length / 2)
  return { left: rowSeats.slice(0, mid), right: rowSeats.slice(mid) }
}

function seatLetterFromDesignator(designator: string): string {
  // "22-B" -> "B". Falls back to the raw string if the format is unexpected.
  const parts = designator.split('-')
  return parts.length === 2 ? parts[1] : designator
}

export default function SeatSelectionPage() {
  const router = useRouter()
  const params = useParams<{ flightKey: string }>()
  const flightKey = decodeURIComponent(params.flightKey)

  const [flight, setFlight] = useState<FlatFlightResult | null>(null)
  const [legs, setLegs] = useState<LegInfo[]>([])
  const [travelerCount, setTravelerCount] = useState(1)
  const [activeLegIndex, setActiveLegIndex] = useState(0)
  const [activeTravelerIndex, setActiveTravelerIndex] = useState(0)

  const [legSeatMaps, setLegSeatMaps] = useState<Record<number, LegSeatMap | null>>({})
  const [loadingLeg, setLoadingLeg] = useState(false)
  const [loadError, setLoadError] = useState('')

  // seatsByPassenger[passengerIndex] = one SelectedSeat per leg they've picked
  const [seatsByPassenger, setSeatsByPassenger] = useState<Record<number, SelectedSeat[]>>({})
  const [hoveredSeat, setHoveredSeat] = useState<string | null>(null)

  useEffect(() => {
    const storedFlight = flowStorage.findResultByFlightKey(flightKey)
    const priced = flowStorage.getPricedFare(flightKey)
    const meta = flowStorage.getSearchMeta()

    if (!storedFlight || !priced) {
      setLoadError('We couldn\u2019t find your priced fare for this flight — it may have expired. Please search again.')
      return
    }

    setFlight(storedFlight)
    setLegs(buildLegs(storedFlight))
    setTravelerCount((meta?.adult ?? 1) + (meta?.child ?? 0) + (meta?.infant ?? 0))
    setSeatsByPassenger(flowStorage.getSelectedSeats(flightKey))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightKey])

  useEffect(() => {
    if (!flight || legs.length === 0) return
    const leg = legs[activeLegIndex]
    if (!leg || legSeatMaps[leg.legIndex] !== undefined) return
    loadLegSeatMap(leg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight, legs, activeLegIndex])

  async function loadLegSeatMap(leg: LegInfo) {
    const priced = flowStorage.getPricedFare(flightKey)
    if (!priced) return

    setLoadingLeg(true)
    try {
      const res = await fetch('/api/book/seatmap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: priced.key,
          referenceNo: priced.referenceNo,
          provider: priced.provider,
          origin: leg.origin,
          destination: leg.destination,
          legIndex: leg.legIndex,
        }),
      })
      const data = await res.json()
      setLegSeatMaps(prev => ({ ...prev, [leg.legIndex]: data.legSeatMap ?? null }))
    } catch {
      setLegSeatMaps(prev => ({ ...prev, [leg.legIndex]: null }))
    } finally {
      setLoadingLeg(false)
    }
  }

  function selectedSeatFor(passengerIndex: number, legIndex: number): SelectedSeat | undefined {
    return seatsByPassenger[passengerIndex]?.find(s => s.legIndex === legIndex)
  }

  function isSeatTakenByAnotherPassenger(seatDesignator: string, legIndex: number, exceptPassengerIndex: number): boolean {
    return Object.entries(seatsByPassenger).some(([paxIdx, seats]) =>
      Number(paxIdx) !== exceptPassengerIndex && seats.some(s => s.legIndex === legIndex && s.SeatDesignator === seatDesignator)
    )
  }

  function pickSeat(seat: SeatCell, legIndex: number) {
    if (seat.seatStatus !== 'OPEN') return
    if (isSeatTakenByAnotherPassenger(seat.seatDesignator, legIndex, activeTravelerIndex)) return

    const newSelection: SelectedSeat = {
      legIndex,
      SeatDesignator: seat.seatDesignator,
      SeatFee: String(seat.seatFee),
      FlightNumber: seat.flightNumber,
      FlightTime: seat.flightTime,
      Equipment: seat.equipment,
      SeatAlignment: seat.seatAlignment,
      OptionalServiceRef: seat.optionalServiceRef,
      Group: seat.group,
      ClassOfService: seat.classOfService,
      Carrier: seat.carrier,
      Paid: seat.paid,
      SegmentRef: seat.segmentRef,
    }

    setSeatsByPassenger(prev => {
      const existing = prev[activeTravelerIndex] ?? []
      const withoutThisLeg = existing.filter(s => s.legIndex !== legIndex)
      const updated = { ...prev, [activeTravelerIndex]: [...withoutThisLeg, newSelection] }
      flowStorage.saveSelectedSeats(flightKey, updated)
      return updated
    })
  }

  function clearSeat(legIndex: number) {
    setSeatsByPassenger(prev => {
      const existing = prev[activeTravelerIndex] ?? []
      const updated = { ...prev, [activeTravelerIndex]: existing.filter(s => s.legIndex !== legIndex) }
      flowStorage.saveSelectedSeats(flightKey, updated)
      return updated
    })
  }

  function handleContinue() {
    flowStorage.saveSelectedSeats(flightKey, seatsByPassenger)
    router.push(`/book/passengers/${encodeURIComponent(flightKey)}`)
  }

  const activeLeg = legs[activeLegIndex]
  const activeSeatMap = activeLeg ? legSeatMaps[activeLeg.legIndex] : null
  const rowGroups = useMemo(() => activeSeatMap ? groupByRow(activeSeatMap.seats) : new Map(), [activeSeatMap])
  const sortedRowNumbers = useMemo(() => Array.from(rowGroups.keys()).sort((a, b) => a - b), [rowGroups])

  const currentSelection = activeLeg ? selectedSeatFor(activeTravelerIndex, activeLeg.legIndex) : undefined

  if (loadError) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.errorCard}>
            <p style={s.errorTitle}>⚠ {loadError}</p>
            <Link href="/book" style={s.errorLink}>← Search again</Link>
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

  return (
    <div style={s.page}>
      <div style={s.root}>
        <Link href={`/book/price/${encodeURIComponent(flightKey)}`} style={s.backLink}>← Back to fare</Link>

        <div style={s.header}>
          <h1 style={s.heading}>Choose your seats</h1>
          <p style={s.sub}>Optional — you can skip this and get a seat at check-in instead.</p>
        </div>

        {/* ── Traveler selector ─────────────────────────────────────── */}
        {travelerCount > 1 && (
          <div style={s.travelerTabs}>
            {Array.from({ length: travelerCount }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActiveTravelerIndex(i)}
                style={{ ...s.travelerTab, ...(activeTravelerIndex === i ? s.travelerTabActive : {}) }}
              >
                Traveler {i + 1}
                {legs.some(l => selectedSeatFor(i, l.legIndex)) && <span style={s.travelerTabDot} />}
              </button>
            ))}
          </div>
        )}

        {/* ── Leg selector ──────────────────────────────────────────── */}
        {legs.length > 1 && (
          <div style={s.legTabs}>
            {legs.map(leg => (
              <button
                key={leg.legIndex}
                type="button"
                onClick={() => setActiveLegIndex(leg.legIndex)}
                style={{ ...s.legTab, ...(activeLegIndex === leg.legIndex ? s.legTabActive : {}) }}
              >
                {leg.origin} → {leg.destination}
              </button>
            ))}
          </div>
        )}

        {/* ── Current selection summary ────────────────────────────── */}
        <div style={s.selectionBar}>
          <div>
            <span style={s.selectionLabel}>
              {travelerCount > 1 ? `Traveler ${activeTravelerIndex + 1} · ` : ''}
              {activeLeg ? `${activeLeg.origin} → ${activeLeg.destination}` : ''}
            </span>
            <div style={s.selectionValue}>
              {currentSelection
                ? `Seat ${currentSelection.SeatDesignator} · ₹${Number(currentSelection.SeatFee).toLocaleString('en-IN')}`
                : 'No seat selected'}
            </div>
          </div>
          {currentSelection && (
            <button type="button" onClick={() => activeLeg && clearSeat(activeLeg.legIndex)} style={s.clearBtn}>
              Clear
            </button>
          )}
        </div>

        {/* ── Seat map ──────────────────────────────────────────────── */}
        <div style={s.planeCard}>
          {loadingLeg && (
            <div style={s.loadingCard}>
              <div style={s.spinner} />
              <p style={s.loadingText}>Loading seat map…</p>
            </div>
          )}

          {!loadingLeg && activeSeatMap && activeSeatMap.available && (
            <div style={s.planeWrap}>
              <div style={s.nose} />
              {sortedRowNumbers.map(rowNo => {
                const { left, right } = splitRow(rowGroups.get(rowNo) ?? [])
                return (
                  <div key={rowNo} style={s.rowLine}>
                    <span style={s.rowNumber}>{rowNo}</span>
                    <div style={s.rowSeats}>
                      {left.map(seat => (
                        <SeatButton
                          key={seat.seatDesignator}
                          seat={seat}
                          isSelected={currentSelection?.SeatDesignator === seat.seatDesignator}
                          isTakenByOther={activeLeg ? isSeatTakenByAnotherPassenger(seat.seatDesignator, activeLeg.legIndex, activeTravelerIndex) : false}
                          onClick={() => activeLeg && pickSeat(seat, activeLeg.legIndex)}
                          onHover={setHoveredSeat}
                          isHovered={hoveredSeat === seat.seatDesignator}
                        />
                      ))}
                      <div style={s.aisle} />
                      {right.map(seat => (
                        <SeatButton
                          key={seat.seatDesignator}
                          seat={seat}
                          isSelected={currentSelection?.SeatDesignator === seat.seatDesignator}
                          isTakenByOther={activeLeg ? isSeatTakenByAnotherPassenger(seat.seatDesignator, activeLeg.legIndex, activeTravelerIndex) : false}
                          onClick={() => activeLeg && pickSeat(seat, activeLeg.legIndex)}
                          onHover={setHoveredSeat}
                          isHovered={hoveredSeat === seat.seatDesignator}
                        />
                      ))}
                    </div>
                    <span style={s.rowNumber}>{rowNo}</span>
                  </div>
                )
              })}
            </div>
          )}

          {!loadingLeg && (!activeSeatMap || !activeSeatMap.available) && (
            <div style={s.noSeatMap}>
              <p style={s.noSeatMapText}>No seat map available for this flight — you can still continue and select a seat at check-in.</p>
            </div>
          )}
        </div>

        {/* ── Legend ────────────────────────────────────────────────── */}
        <div style={s.legend}>
          <div style={s.legendItem}><span style={{ ...s.legendSwatch, ...s.seatOpen }} /> Available</div>
          <div style={s.legendItem}><span style={{ ...s.legendSwatch, ...s.seatOccupied }}>✕</span> Occupied</div>
          <div style={s.legendItem}><span style={{ ...s.legendSwatch, ...s.seatSelected }} /> Selected</div>
        </div>

        <button type="button" onClick={handleContinue} style={s.continueBtn}>
          {Object.values(seatsByPassenger).some(seats => seats.length > 0) ? 'Continue to passenger details →' : 'Skip seat selection →'}
        </button>
      </div>
    </div>
  )
}

function SeatButton({
  seat, isSelected, isTakenByOther, onClick, onHover, isHovered,
}: {
  seat: SeatCell
  isSelected: boolean
  isTakenByOther: boolean
  onClick: () => void
  onHover: (designator: string | null) => void
  isHovered: boolean
}) {
  const isOpen = seat.seatStatus === 'OPEN' && !isTakenByOther
  const letter = seatLetterFromDesignator(seat.seatDesignator)
  const isExit = Boolean(seat.exitSeats)

  return (
    <div style={s.seatOuter}>
      <button
        type="button"
        disabled={!isOpen}
        onClick={onClick}
        onMouseEnter={() => onHover(seat.seatDesignator)}
        onMouseLeave={() => onHover(null)}
        style={{
          ...s.seatBase,
          ...(isSelected ? s.seatSelected : isOpen ? s.seatOpen : s.seatOccupied),
          ...(isExit ? s.seatExit : {}),
        }}
        title={isOpen ? `Seat ${seat.seatDesignator} · ₹${seat.seatFee.toLocaleString('en-IN')}` : undefined}
      >
        {isOpen ? letter : '✕'}
      </button>
      {isHovered && isOpen && (
        <div style={s.seatTooltip}>
          {seat.seatDesignator} · ₹{seat.seatFee.toLocaleString('en-IN')}
          {isExit && <div style={s.seatTooltipExit}>Exit row</div>}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '640px', margin: '0 auto', padding: '32px 24px 64px' },

  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  loadingCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', padding: '56px 20px' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },
  loadingText: { fontSize: '13px', color: '#6B7280', margin: 0 },

  errorCard: { padding: '20px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '14px' },
  errorTitle: { fontSize: '13px', color: '#DC2626', margin: '0 0 10px', lineHeight: 1.5 },
  errorLink: { fontSize: '13px', color: '#DC2626', fontWeight: 600, textDecoration: 'underline' },

  travelerTabs: { display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' as const },
  travelerTab: {
    fontSize: '12px', fontWeight: 600, color: '#6B7280', background: '#fff', border: '1px solid #E5E7EB',
    borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
  },
  travelerTabActive: { color: '#000835', borderColor: '#000835', background: '#EEF2FF' },
  travelerTabDot: { width: '6px', height: '6px', borderRadius: '50%', background: '#22C55E', display: 'inline-block' },

  legTabs: { display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' as const },
  legTab: {
    fontSize: '12px', fontWeight: 600, color: '#6B7280', background: '#fff', border: '1px solid #E5E7EB',
    borderRadius: '8px', padding: '8px 12px', cursor: 'pointer',
  },
  legTabActive: { color: '#000835', borderColor: '#000835', background: '#EEF2FF' },

  selectionBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '14px 16px', marginBottom: '16px',
  },
  selectionLabel: { fontSize: '11px', color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.3px' },
  selectionValue: { fontSize: '14px', color: '#111827', fontWeight: 700, marginTop: '2px' },
  clearBtn: { fontSize: '12px', color: '#DC2626', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' },

  planeCard: {
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '18px', padding: '24px 16px', marginBottom: '16px',
    minHeight: '200px', display: 'flex', justifyContent: 'center',
  },
  planeWrap: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '6px', width: '100%' },
  nose: {
    width: '60px', height: '30px', background: '#F3F4F6', borderRadius: '50% 50% 0 0', marginBottom: '8px',
    border: '1px solid #E5E7EB', borderBottom: 'none',
  },

  rowLine: { display: 'flex', alignItems: 'center', gap: '10px', width: '100%', justifyContent: 'center' },
  rowNumber: { fontSize: '10px', color: '#9CA3AF', fontWeight: 600, width: '16px', textAlign: 'center' as const, flexShrink: 0 },
  rowSeats: { display: 'flex', alignItems: 'center', gap: '5px' },
  aisle: { width: '16px', flexShrink: 0 },

  seatOuter: { position: 'relative' as const },
  seatBase: {
    width: '28px', height: '28px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none', flexShrink: 0,
  },
  seatOpen: { background: '#fff', color: '#374151', border: '1.5px solid #D1D5DB', cursor: 'pointer' },
  seatOccupied: { background: '#E5E7EB', color: '#9CA3AF', cursor: 'not-allowed', border: '1.5px solid #E5E7EB' },
  seatSelected: { background: '#000835', color: '#fff', border: '1.5px solid #000835' },
  seatExit: { boxShadow: '0 0 0 1.5px #F59E0B inset' },

  seatTooltip: {
    position: 'absolute' as const, bottom: '32px', left: '50%', transform: 'translateX(-50%)',
    background: '#111827', color: '#fff', fontSize: '10px', fontWeight: 600, padding: '4px 8px',
    borderRadius: '6px', whiteSpace: 'nowrap' as const, zIndex: 10, pointerEvents: 'none' as const,
  },
  seatTooltipExit: { color: '#FBBF24', fontSize: '9px', fontWeight: 500, marginTop: '2px' },

  noSeatMap: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', width: '100%' },
  noSeatMapText: { fontSize: '13px', color: '#6B7280', textAlign: 'center' as const, lineHeight: 1.6, margin: 0 },

  legend: { display: 'flex', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' as const },
  legendItem: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#6B7280' },
  legendSwatch: { width: '16px', height: '16px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', fontWeight: 700 },

  continueBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}
