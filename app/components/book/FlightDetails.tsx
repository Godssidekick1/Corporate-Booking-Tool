import AirlineMark from '@/app/components/AirlineMark'
import {
  baggageLabel, formatDayLabel, formatTime, journeyLabel, journeysOf,
  type FlatFlightResult, type Journey, type StopInfo,
} from '@/app/lib/book/types'

// ── A booked flight, in full ─────────────────────────────────────────────────
// What the traveller saw when choosing it: each direction's times, airports,
// terminals and day, the duration, every stop with its layover, the flight
// numbers, cabin and baggage. Built from a stored itinerary (the traveller-
// safe projection, app/lib/book/travellerView.ts), so it carries no fares.
// Used by the approver's card; plain enough for any booking view.
// ─────────────────────────────────────────────────────────────────────────────

function layover(stop: StopInfo): string | null {
  if (!stop.departureDateTime) return null
  const mins = Math.round((Date.parse(stop.departureDateTime) - Date.parse(stop.arrivalDateTime)) / 60_000)
  if (!Number.isFinite(mins) || mins <= 0) return null
  const h = Math.floor(mins / 60)
  return h ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}

function JourneyBlock({ journey, labelled }: { journey: Journey; labelled: boolean }) {
  const numbers = journey.legs.map(l => [l.airlineCode, l.flightNumber].filter(Boolean).join(' ')).filter(Boolean)
  const checkIn = baggageLabel(journey.checkInBaggageKg, journey.checkInBaggagePieces)
  const cabinBag = baggageLabel(journey.cabinBaggageKg, journey.cabinBaggagePieces)
  return (
    <div style={s.journey}>
      {labelled && <div style={s.journeyLabel}>{journeyLabel(journey.journeyNo)}</div>}
      <div style={s.route}>
        <div style={s.point}>
          <span style={s.time}>{formatTime(journey.origin?.dateTime)}</span>
          <span style={s.code}>{journey.origin?.code}</span>
          <span style={s.place}>{journey.origin?.city}{journey.origin?.terminal ? ` · T${journey.origin.terminal}` : ''}</span>
          <span style={s.day}>{formatDayLabel(journey.origin?.dateTime)}</span>
        </div>
        <div style={s.middle}>
          <span style={s.duration}>{journey.totalDuration ?? journey.duration ?? ''}</span>
          <div style={s.line} />
          <span style={s.stopsText}>{journey.stopCount === 0 ? 'Non-stop' : `${journey.stopCount} stop${journey.stopCount > 1 ? 's' : ''}`}</span>
        </div>
        <div style={{ ...s.point, alignItems: 'flex-end', textAlign: 'right' }}>
          <span style={s.time}>{formatTime(journey.destination?.dateTime)}</span>
          <span style={s.code}>{journey.destination?.code}</span>
          <span style={s.place}>{journey.destination?.city}{journey.destination?.terminal ? ` · T${journey.destination.terminal}` : ''}</span>
          <span style={s.day}>{formatDayLabel(journey.destination?.dateTime)}</span>
        </div>
      </div>
      <ul style={s.facts}>
        {numbers.length > 0 && <li>Flight {numbers.join(' + ')}</li>}
        {journey.stops.map((stop, i) => {
          const wait = layover(stop)
          return <li key={i}>Change in {stop.city || stop.code}{wait ? `, ${wait} layover` : ''}</li>
        })}
        {(checkIn || cabinBag) && (
          <li>Baggage: {[checkIn && `${checkIn} check-in`, cabinBag && `${cabinBag} cabin`].filter(Boolean).join(', ')}</li>
        )}
      </ul>
    </div>
  )
}

export default function FlightDetails({ itinerary }: { itinerary: unknown }) {
  const flight = itinerary as FlatFlightResult | null
  if (!flight) return null
  const journeys = journeysOf(flight)
  if (!journeys.length || !journeys[0].origin) return null
  const airline = flight.airline ?? journeys[0].airline
  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <AirlineMark code={airline?.code ?? flight.legs?.[0]?.airlineCode} name={airline?.name} size={28} />
        <div>
          <div style={s.airline}>{airline?.name ?? airline?.code ?? 'Airline'}</div>
          <div style={s.meta}>
            {[flight.cabin ?? 'Economy', flight.isLcc ? 'Budget carrier' : 'Full-service'].join(' · ')}
          </div>
        </div>
      </div>
      {journeys.map(j => <JourneyBlock key={j.journeyNo} journey={j} labelled={journeys.length > 1} />)}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { border: '1px solid #E5E7EB', borderRadius: 12, padding: '12px 14px', background: '#fff', display: 'flex', flexDirection: 'column', gap: 12 },
  head: { display: 'flex', alignItems: 'center', gap: 10 },
  airline: { fontSize: 13.5, fontWeight: 700, color: '#111827' },
  meta: { fontSize: 11.5, color: '#6B7280' },
  journey: { borderTop: '1px solid #F3F4F6', paddingTop: 10 },
  journeyLabel: { fontSize: 10.5, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 },
  route: { display: 'flex', alignItems: 'center', gap: 12 },
  point: { display: 'flex', flexDirection: 'column', minWidth: 92 },
  time: { fontSize: 17, fontWeight: 700, color: '#0A0A14', fontVariantNumeric: 'tabular-nums' },
  code: { fontSize: 12.5, fontWeight: 700, color: '#374151' },
  place: { fontSize: 11.5, color: '#6B7280' },
  day: { fontSize: 11, color: '#9CA3AF' },
  middle: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 },
  duration: { fontSize: 11.5, color: '#374151', fontWeight: 600 },
  line: { width: '100%', height: 1, background: '#D1D5DB' },
  stopsText: { fontSize: 11, color: '#6B7280' },
  facts: { margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: '#4B5563' },
}
