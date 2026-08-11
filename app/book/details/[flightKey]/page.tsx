'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { flowStorage, PricedFare } from '@/app/lib/book/flowStorage'
import {
  FlatFlightResult, formatTime, formatDayLabel, SelectedSeat, TravelerProfile,
  LegSeatMap, SeatCell,
} from '@/app/lib/book/types'
import { countryNameFromCode } from '@/app/lib/data/countryCodes'
import { classifyTrip } from '@/app/lib/rule-engine/classifyTrip'

// ── /book/details/[flightKey] ─────────────────────────────────────────────────
// Merges what used to be two separate steps (/book/seats then
// /book/passengers) into one page: passenger details first, seat selection
// below it, one "Continue to review" action. Booking flow is now
// search → price → details (this page) → confirm → ticket.
//
// Passenger identity drives seat selection here (not just a numeric index) —
// the seat traveler-tabs show each passenger's typed name once they've
// entered one, falling back to "Traveler N" until then.
// ─────────────────────────────────────────────────────────────────────────────

// Matches CustomerInfo.PassengerDetails[number] in lib/amadeus/client.ts exactly.
interface PassengerForm {
  paxType: 'ADT' | 'CHD' | 'INF'
  title: string
  gender: string
  firstName: string
  middleName: string
  lastName: string
  dateOfBirth: string   // <input type="date"> value, YYYY-MM-DD — converted on submit
  passportNumber: string
  issuingCountry: string
  nationality: string
  expiryDate: string    // <input type="date"> value, YYYY-MM-DD — converted on submit
}

function emptyPassenger(paxType: PassengerForm['paxType']): PassengerForm {
  return {
    paxType,
    title: paxType === 'INF' ? 'MSTR' : 'MR',
    gender: 'Male',
    firstName: '', middleName: '', lastName: '',
    dateOfBirth: '', passportNumber: '', issuingCountry: 'IN', nationality: 'IN', expiryDate: '',
  }
}

function toAmadeusDate(value: string): string {
  // <input type="date"> gives YYYY-MM-DD — Amadeus wants DD/MM/YYYY.
  const [y, m, d] = value.split('-')
  return `${d}/${m}/${y}`
}

// Inverse of toAmadeusDate — TravelerProfile stores DD/MM/YYYY (matching
// AddPassengerDetails' own format), but <input type="date"> needs YYYY-MM-DD.
function fromAmadeusDate(value: string | undefined): string {
  if (!value) return ''
  const [d, m, y] = value.split('/')
  if (!d || !m || !y) return ''
  return `${y}-${m}-${d}`
}

// Slot 1 (index 0, first adult) is the only slot ever autofilled — it's the
// only one that can reliably be "the employee themselves." Guarded by
// isGuestBooking() at the call site: if the trip was flagged as being for
// someone else, this never runs, so a guest's passport details are never
// silently overwritten with the employee's own.
function applyTravelerProfile(passenger: PassengerForm, profile: TravelerProfile): PassengerForm {
  return {
    ...passenger,
    title: profile.title || passenger.title,
    gender: profile.gender || passenger.gender,
    dateOfBirth: fromAmadeusDate(profile.dateOfBirth) || passenger.dateOfBirth,
    passportNumber: profile.passportNumber ?? passenger.passportNumber,
    issuingCountry: profile.issuingCountry ?? passenger.issuingCountry,
    nationality: profile.nationality ?? passenger.nationality,
    expiryDate: fromAmadeusDate(profile.passportExpiryDate) || passenger.expiryDate,
  }
}

// Selected seats are stored per-leg (legIndex) but AddPassenger just wants a
// flat array per passenger — strips legIndex since Amadeus doesn't need it,
// it's only used internally to key storage/UI on this page.
function toSeatListDetails(seats: SelectedSeat[] | undefined) {
  if (!seats || seats.length === 0) return []
  return seats.map(({ legIndex, ...rest }) => rest)
}

const PAX_TYPE_LABEL: Record<PassengerForm['paxType'], string> = {
  ADT: 'Adult', CHD: 'Child', INF: 'Infant',
}

function ageInYears(dob: string): number {
  const birth = new Date(dob)
  const now = new Date()
  let age = now.getFullYear() - birth.getFullYear()
  const monthDiff = now.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age--
  return age
}

function validateAge(paxType: PassengerForm['paxType'], dob: string): string | null {
  if (!dob) return null // required-field validation handles empty separately
  const birth = new Date(dob)
  if (isNaN(birth.getTime()) || birth > new Date()) {
    return 'Date of birth cannot be in the future.'
  }
  const age = ageInYears(dob)
  if (paxType === 'ADT' && age < 12) {
    return 'Adult passengers must be 12 years or older. Add this traveler as a child instead.'
  }
  if (paxType === 'CHD' && (age < 2 || age > 11)) {
    return 'Child passengers must be between 2 and 11 years old.'
  }
  if (paxType === 'INF' && age >= 2) {
    return 'Infant passengers must be under 2 years old.'
  }
  return null
}

function validateEmail(email: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.'
  return null
}

function validateMobile(mobile: string): string | null {
  // Indian mobile numbers: 10 digits, starting 6-9. Adjust if supporting other countries.
  if (!/^[6-9]\d{9}$/.test(mobile)) return 'Enter a valid 10-digit mobile number.'
  return null
}

// ── Seat selection helpers (unchanged from /book/seats) ──────────────────────

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

// Display label for a seat-selector tab: the traveler's typed name if
// they've entered one, otherwise a generic fallback — so seat picking still
// works before anyone's typed a name, but upgrades to something readable
// the moment they have.
function travelerLabel(passenger: PassengerForm, index: number): string {
  const name = [passenger.firstName, passenger.lastName].filter(Boolean).join(' ').trim()
  return name || `Traveler ${index + 1}`
}

export default function BookingDetailsPage() {
  const router = useRouter()
  const params = useParams<{ flightKey: string }>()
  const flightKey = decodeURIComponent(params.flightKey)

  const [flight, setFlight] = useState<FlatFlightResult | null>(null)
  const [priced, setPriced] = useState<PricedFare | null>(null)
  const [loadError, setLoadError] = useState('')

  // ── Passenger state ─────────────────────────────────────────────────────
  const [passengers, setPassengers] = useState<PassengerForm[]>([])
  const [email, setEmail] = useState('')
  const [mobile, setMobile] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zipCode, setZipCode] = useState('')
  const [tripType, setTripType] = useState<'domestic' | 'international'>('domestic')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // Booking-for-self (the default) locks slot-1 identity fields and contact
  // details to whatever's saved on the traveler's profile — that profile is
  // the corporate record of who this person is and how to reach them, so
  // changes belong there, not as a one-off override on a single booking.
  // Guest bookings (isGuestBooking() true) skip autofill entirely and leave
  // everything editable, same as before.
  const [isSelfBooking, setIsSelfBooking] = useState(false)

  // ── Seat state ───────────────────────────────────────────────────────────
  const [legs, setLegs] = useState<LegInfo[]>([])
  const [activeLegIndex, setActiveLegIndex] = useState(0)
  const [activeTravelerIndex, setActiveTravelerIndex] = useState(0)
  const [legSeatMaps, setLegSeatMaps] = useState<Record<number, LegSeatMap | null>>({})
  const [loadingLeg, setLoadingLeg] = useState(false)
  // seatsByPassenger[passengerIndex] = one SelectedSeat per leg they've picked
  const [seatsByPassenger, setSeatsByPassenger] = useState<Record<number, SelectedSeat[]>>({})
  const [hoveredSeat, setHoveredSeat] = useState<string | null>(null)

  useEffect(() => {
    const storedFlight = flowStorage.findResultByFlightKey(flightKey)
    const storedPriced = flowStorage.getPricedFare(flightKey)
    const meta = flowStorage.getSearchMeta()

    if (!storedFlight || !storedPriced) {
      setLoadError('We couldn\u2019t find your priced fare for this flight — it may have expired. Please search again.')
      return
    }

    setFlight(storedFlight)
    setPriced(storedPriced)
    setLegs(buildLegs(storedFlight))
    setSeatsByPassenger(flowStorage.getSelectedSeats(flightKey))

    // Domestic vs international drives whether passport fields are shown/required —
    // reuses the same classifyTrip logic the Rule Engine uses, built from every
    // leg of the itinerary (origin -> each stop -> destination).
    let isInternational = false
    if (storedFlight.origin?.code && storedFlight.destination?.code) {
      const points = [
        storedFlight.origin.code,
        ...storedFlight.stops.map(s => s.code),
        storedFlight.destination.code,
      ]
      const classifyLegs = points.slice(0, -1).map((origin, i) => ({ origin, destination: points[i + 1] }))
      const classified = classifyTrip(classifyLegs)
      setTripType(classified)
      isInternational = classified === 'international'
    }

    // Build one form per passenger, tagged with the right PaxType, based on
    // the counts from search. Falls back to a single adult if search meta
    // is somehow missing (shouldn't happen in normal flow).
    const adultCount = meta?.adult ?? 1
    const childCount = meta?.child ?? 0
    const infantCount = meta?.infant ?? 0

    const built: PassengerForm[] = [
      ...Array.from({ length: adultCount }, () => emptyPassenger('ADT')),
      ...Array.from({ length: childCount }, () => emptyPassenger('CHD')),
      ...Array.from({ length: infantCount }, () => emptyPassenger('INF')),
    ]
    setPassengers(built)

    // Autofill passenger slot 1 from the employee's saved travel profile —
    // silent, since this is the common case (booking for yourself). Skipped
    // entirely when this trip is flagged as being for a guest, so a
    // colleague's details are never silently overwritten with the
    // employee's own. isSelfBooking (and the resulting field lock) is only
    // turned on once loadTravelerProfile() confirms there's real profile
    // data to lock to — an employee who hasn't filled in /profile yet, or
    // whose saved profile is missing passport details an international
    // trip needs, must not get stuck staring at locked, empty fields with
    // no way to complete their own booking.
    if (!flowStorage.isGuestBooking()) {
      loadTravelerProfile(isInternational)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightKey])

  useEffect(() => {
    if (!flight || legs.length === 0) return
    const leg = legs[activeLegIndex]
    if (!leg || legSeatMaps[leg.legIndex] !== undefined) return
    loadLegSeatMap(leg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight, legs, activeLegIndex])

  async function loadTravelerProfile(isInternational: boolean) {
    try {
      const res = await fetch('/api/employees/me')
      if (!res.ok) return
      const data = await res.json()
      const profile: TravelerProfile | null = data.travelerProfile
      const fullName: string | undefined = data.fullName

      // Name comes from employees.full_name (the actual source of truth for
      // "who is this person"), not traveler_profile — split into
      // first/middle/last the same way the passport form expects. A single
      // name with no spaces becomes first name only; the middle segment(s)
      // of a 3+ word name are joined back together rather than dropped.
      if (fullName?.trim()) {
        const parts = fullName.trim().split(/\s+/)
        const firstName = parts[0] ?? ''
        const lastName = parts.length > 1 ? parts[parts.length - 1] : ''
        const middleName = parts.length > 2 ? parts.slice(1, -1).join(' ') : ''
        setPassengers(prev =>
          prev.length > 0 && prev[0].paxType === 'ADT'
            ? prev.map((p, i) => i === 0 ? { ...p, firstName, middleName, lastName } : p)
            : prev
        )
      }

      if (!profile) return
      setPassengers(prev =>
        prev.length > 0 && prev[0].paxType === 'ADT'
          ? prev.map((p, i) => i === 0 ? applyTravelerProfile(p, profile) : p)
          : prev
      )
      // Contact details come from the same profile — locked alongside
      // identity fields when booking for yourself (see isSelfBooking).
      if (profile.email) setEmail(profile.email)
      if (profile.mobile) setMobile(profile.mobile)
      if (profile.address) setAddress(profile.address)
      if (profile.city) setCity(profile.city)
      if (profile.state) setState(profile.state)
      if (profile.zipCode) setZipCode(profile.zipCode)

      // Only lock the fields once there's actually complete data to lock
      // to — required identity + contact fields at minimum, plus passport
      // fields specifically when this trip needs them. Otherwise an
      // employee with an unfilled or incomplete profile would be stuck
      // staring at locked, empty fields with no way to finish their own
      // booking (short of leaving this page to go fill in /profile first,
      // which the "Edit in travel profile" link still offers either way).
      const hasCoreDetails = Boolean(
        fullName?.trim() && profile.title && profile.gender && profile.dateOfBirth &&
        profile.email && profile.mobile && profile.address && profile.city && profile.state && profile.zipCode
      )
      const hasPassportIfNeeded = !isInternational || Boolean(
        profile.passportNumber && profile.issuingCountry && profile.nationality && profile.passportExpiryDate
      )
      if (hasCoreDetails && hasPassportIfNeeded) {
        setIsSelfBooking(true)
      }
    } catch {
      // Autofill is a convenience, not a required step — silently do
      // nothing on failure and let the employee type their details as normal.
    }
  }

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

  function updatePassenger<K extends keyof PassengerForm>(index: number, key: K, value: PassengerForm[K]) {
    setPassengers(prev => prev.map((p, i) => i === index ? { ...p, [key]: value } : p))
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

  function validateAll(): boolean {
    const errors: Record<string, string> = {}

    passengers.forEach((p, i) => {
      const ageError = validateAge(p.paxType, p.dateOfBirth)
      if (ageError) errors[`passenger-${i}-dob`] = ageError
    })

    const emailError = validateEmail(email)
    if (emailError) errors['contact-email'] = emailError

    const mobileError = validateMobile(mobile)
    if (mobileError) errors['contact-mobile'] = mobileError

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!priced) return

    setError('')
    if (!validateAll()) {
      setError('Please fix the highlighted fields before continuing.')
      return
    }

    setSubmitting(true)

    try {
      const res = await fetch('/api/book/add-passenger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: priced.key,
          pricingKey: priced.pricingKey,
          provider: priced.provider,
          referenceNo: priced.referenceNo,
          totalFare: priced.totalFare,
          currency: priced.currency,
          isRefundable: priced.isRefundable,
          fareType: priced.fareType,
          passengerBreakup: priced.passengerBreakup,
          isNdc: priced.isNdc,
          searchKey: priced.searchKey,
          itinerary: flight,
          customerInfo: {
            Email: email,
            Mobile: mobile,
            Address: address,
            City: city,
            State: state,
            CountryCode: passengers[0]?.nationality ?? 'IN',
            CountryName: countryNameFromCode(passengers[0]?.nationality ?? 'IN'), // Amadeus rejects empty CountryName (ModelState validation)
            ZipCode: zipCode,
            PassengerDetails: passengers.map((p, i) => ({
              Title: p.title,
              Gender: p.gender,
              FirstName: p.firstName,
              MiddleName: p.middleName,
              LastName: p.lastName,
              DateOfBirth: toAmadeusDate(p.dateOfBirth),
              PaxType: p.paxType,
              PassportNumber: p.passportNumber,
              IssuingCountry: p.issuingCountry,
              Nationality: p.nationality,
              ExpiryDate: toAmadeusDate(p.expiryDate),
              MealCode: '',
              SeatListDetails: toSeatListDetails(seatsByPassenger[i]),
            })),
          },
        }),
      })

      const data = await res.json()

      if (!data.ok) {
        setError(data.error || 'Could not save passenger details. Please try again.')
        return
      }

      // add-passenger created the bookings row — from here on the flow is
      // keyed by bookingId, not flightKey, and sessionStorage is done being used.
      router.push(`/book/confirm/${data.bookingId}`)
    } catch {
      setError('Something went wrong saving passenger details. Please try again.')
    } finally {
      setSubmitting(false)
    }
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

  if (!flight || !priced || passengers.length === 0) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.loadingCard}>
            <div style={s.spinner} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={s.page}>
      <div style={s.root}>
        <Link href={`/book/price/${encodeURIComponent(flightKey)}`} style={s.backLink}>← Back to fare</Link>

        <div style={s.header}>
          <h1 style={s.heading}>Passenger details</h1>
          <p style={s.sub}>
            {passengers.length > 1
              ? `Enter details for all ${passengers.length} travelers, then pick seats if you'd like.`
              : 'Enter details exactly as they appear on the traveler\u2019s ID, then pick a seat if you\u2019d like.'}
          </p>
        </div>

        {/* ── Flight + fare summary strip ─────────────────────────── */}
        <div style={s.summaryCard}>
          <div style={s.summaryRoute}>
            <span style={s.summaryCode}>{flight.origin?.code}</span>
            <span style={s.summaryArrow}>→</span>
            <span style={s.summaryCode}>{flight.destination?.code}</span>
            <span style={s.summaryMeta}>
              {formatTime(flight.origin?.dateTime)} · {formatDayLabel(flight.origin?.dateTime)}
            </span>
          </div>
          <div style={s.summaryFare}>{priced.currency} {priced.totalFare.toLocaleString('en-IN')}</div>
        </div>

        <form onSubmit={handleSubmit}>
          {/* ── One card per passenger ──────────────────────────────── */}
          {passengers.map((passenger, i) => {
            const locked = i === 0 && isSelfBooking
            return (
            <div style={s.card} key={i}>
              <h2 style={s.cardTitle}>
                Traveler {passengers.length > 1 ? `${i + 1} of ${passengers.length}` : ''}
                <span style={s.paxTypeBadge}>{PAX_TYPE_LABEL[passenger.paxType]}</span>
              </h2>
              {locked && (
                <p style={s.lockedNote}>
                  These details come from your travel profile.{' '}
                  <Link href="/profile" style={s.lockedLink}>Edit in travel profile →</Link>
                </p>
              )}

              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>Title</label>
                  <select value={passenger.title} disabled={locked} onChange={e => updatePassenger(i, 'title', e.target.value)} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }}>
                    {passenger.paxType === 'INF' ? (
                      <>
                        <option value="MSTR">Master</option>
                        <option value="MISS">Miss</option>
                      </>
                    ) : (
                      <>
                        <option value="MR">Mr</option>
                        <option value="MRS">Mrs</option>
                        <option value="MS">Ms</option>
                      </>
                    )}
                  </select>
                </div>
                <div style={s.field}>
                  <label style={s.label}>Gender</label>
                  <select value={passenger.gender} disabled={locked} onChange={e => updatePassenger(i, 'gender', e.target.value)} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }}>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </div>
                <div style={s.field}>
                  <label style={s.label}>Date of birth</label>
                  <input
                    type="date" required disabled={locked} value={passenger.dateOfBirth}
                    onChange={e => updatePassenger(i, 'dateOfBirth', e.target.value)}
                    style={{ ...s.input, ...(locked ? s.inputLocked : {}), borderColor: fieldErrors[`passenger-${i}-dob`] ? '#DC2626' : undefined }}
                  />
                  {fieldErrors[`passenger-${i}-dob`] && (
                    <p style={s.fieldError}>{fieldErrors[`passenger-${i}-dob`]}</p>
                  )}
                </div>
              </div>

              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>First name</label>
                  <input type="text" required disabled={locked} value={passenger.firstName} onChange={e => updatePassenger(i, 'firstName', e.target.value)} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }} placeholder="As on ID" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Middle name</label>
                  <input type="text" disabled={locked} value={passenger.middleName} onChange={e => updatePassenger(i, 'middleName', e.target.value)} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }} />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Last name</label>
                  <input type="text" required disabled={locked} value={passenger.lastName} onChange={e => updatePassenger(i, 'lastName', e.target.value)} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }} placeholder="As on ID" />
                </div>
              </div>

              {tripType === 'international' && (
                <>
                  <div style={s.grid3}>
                    <div style={s.field}>
                      <label style={s.label}>Passport number</label>
                      <input type="text" required disabled={locked} value={passenger.passportNumber} onChange={e => updatePassenger(i, 'passportNumber', e.target.value)} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }} />
                    </div>
                    <div style={s.field}>
                      <label style={s.label}>Issuing country</label>
                      <input type="text" required disabled={locked} value={passenger.issuingCountry} onChange={e => updatePassenger(i, 'issuingCountry', e.target.value.toUpperCase())} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }} maxLength={2} placeholder="IN" />
                    </div>
                    <div style={s.field}>
                      <label style={s.label}>Nationality</label>
                      <input type="text" required disabled={locked} value={passenger.nationality} onChange={e => updatePassenger(i, 'nationality', e.target.value.toUpperCase())} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }} maxLength={2} placeholder="IN" />
                    </div>
                  </div>

                  <div style={s.field}>
                    <label style={s.label}>Passport expiry</label>
                    <input type="date" required disabled={locked} value={passenger.expiryDate} onChange={e => updatePassenger(i, 'expiryDate', e.target.value)} style={{ ...s.input, ...(locked ? s.inputLocked : {}) }} />
                  </div>
                </>
              )}
            </div>
            )
          })}

          {/* ── Contact details (shared, not per-passenger) ─────────── */}
          <div style={s.card}>
            <h2 style={s.cardTitle}>Contact details</h2>
            <p style={s.cardSub}>We'll send booking confirmations and updates here.</p>
            {isSelfBooking && (
              <p style={s.lockedNote}>
                These come from your travel profile.{' '}
                <Link href="/profile" style={s.lockedLink}>Edit in travel profile →</Link>
              </p>
            )}

            <div style={s.grid2}>
              <div style={s.field}>
                <label style={s.label}>Email</label>
                <input
                  type="email" required disabled={isSelfBooking} value={email} onChange={e => setEmail(e.target.value)}
                  style={{ ...s.input, ...(isSelfBooking ? s.inputLocked : {}), borderColor: fieldErrors['contact-email'] ? '#DC2626' : undefined }}
                />
                {fieldErrors['contact-email'] && <p style={s.fieldError}>{fieldErrors['contact-email']}</p>}
              </div>
              <div style={s.field}>
                <label style={s.label}>Mobile</label>
                <input
                  type="tel" required disabled={isSelfBooking} value={mobile} onChange={e => setMobile(e.target.value)}
                  style={{ ...s.input, ...(isSelfBooking ? s.inputLocked : {}), borderColor: fieldErrors['contact-mobile'] ? '#DC2626' : undefined }}
                  placeholder="10-digit number"
                />
                {fieldErrors['contact-mobile'] && <p style={s.fieldError}>{fieldErrors['contact-mobile']}</p>}
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>Address</label>
              <input type="text" required disabled={isSelfBooking} value={address} onChange={e => setAddress(e.target.value)} style={{ ...s.input, ...(isSelfBooking ? s.inputLocked : {}) }} />
            </div>

            <div style={s.grid3}>
              <div style={s.field}>
                <label style={s.label}>City</label>
                <input type="text" required disabled={isSelfBooking} value={city} onChange={e => setCity(e.target.value)} style={{ ...s.input, ...(isSelfBooking ? s.inputLocked : {}) }} />
              </div>
              <div style={s.field}>
                <label style={s.label}>State</label>
                <input type="text" required disabled={isSelfBooking} value={state} onChange={e => setState(e.target.value)} style={{ ...s.input, ...(isSelfBooking ? s.inputLocked : {}) }} />
              </div>
              <div style={s.field}>
                <label style={s.label}>ZIP code</label>
                <input type="text" required disabled={isSelfBooking} value={zipCode} onChange={e => setZipCode(e.target.value)} style={{ ...s.input, ...(isSelfBooking ? s.inputLocked : {}) }} />
              </div>
            </div>
          </div>

          {/* ── Seat selection ───────────────────────────────────────── */}
          <div style={s.card}>
            <h2 style={s.cardTitle}>Choose your seats</h2>
            <p style={s.cardSub}>Optional — you can skip this and get a seat at check-in instead.</p>

            {passengers.length > 1 && (
              <div style={s.travelerTabs}>
                {passengers.map((passenger, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setActiveTravelerIndex(i)}
                    style={{ ...s.travelerTab, ...(activeTravelerIndex === i ? s.travelerTabActive : {}) }}
                  >
                    {travelerLabel(passenger, i)}
                    {legs.some(l => selectedSeatFor(i, l.legIndex)) && <span style={s.travelerTabDot} />}
                  </button>
                ))}
              </div>
            )}

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

            <div style={s.selectionBar}>
              <div>
                <span style={s.selectionLabel}>Selected seat</span>
                <div style={s.selectionValue}>
                  {currentSelection ? `${currentSelection.SeatDesignator} · ₹${Number(currentSelection.SeatFee).toLocaleString('en-IN')}` : 'None yet'}
                </div>
              </div>
              {currentSelection && (
                <button type="button" onClick={() => activeLeg && clearSeat(activeLeg.legIndex)} style={s.clearBtn}>
                  Clear
                </button>
              )}
            </div>

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

            <div style={s.legend}>
              <div style={s.legendItem}><span style={{ ...s.legendSwatch, ...s.seatOpen }} /> Available</div>
              <div style={s.legendItem}><span style={{ ...s.legendSwatch, ...s.seatOccupied }}>✕</span> Occupied</div>
              <div style={s.legendItem}><span style={{ ...s.legendSwatch, ...s.seatSelected }} /> Selected</div>
            </div>
          </div>

          {error && (
            <div style={s.errorBanner}>
              <span style={s.bannerIcon}>⚠</span> {error}
            </div>
          )}

          <button type="submit" disabled={submitting} style={{ ...s.continueBtn, opacity: submitting ? 0.7 : 1 }}>
            {submitting ? 'Saving…' : 'Continue to review →'}
          </button>
        </form>
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

  summaryCard: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '14px 18px', marginBottom: '20px' },
  summaryRoute: { display: 'flex', alignItems: 'center', gap: '8px' },
  summaryCode: { fontSize: '14px', fontWeight: 700, color: '#111827' },
  summaryArrow: { fontSize: '12px', color: '#9CA3AF' },
  summaryMeta: { fontSize: '11px', color: '#9CA3AF', marginLeft: '8px' },
  summaryFare: { fontSize: '15px', fontWeight: 700, color: '#0A0A14' },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '14px', padding: '20px', marginBottom: '16px' },
  cardTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '8px' },
  cardSub: { fontSize: '12px', color: '#9CA3AF', margin: '0 0 16px' },

  lockedNote: { fontSize: '11.5px', color: '#6B7280', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '8px', padding: '8px 12px', margin: '-4px 0 16px' },
  lockedLink: { color: '#000835', fontWeight: 600, textDecoration: 'none' },

  paxTypeBadge: { fontSize: '10px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '2px 8px', borderRadius: '5px', letterSpacing: '0.3px' },

  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '12px' },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '7px', outline: 'none' },
  inputLocked: { background: '#F3F4F6', color: '#6B7280', cursor: 'not-allowed' },
  fieldError: { fontSize: '10.5px', color: '#DC2626', margin: '2px 0 0' },

  // ── Seat selection styles ────────────────────────────────────────────────
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
    background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '14px 16px', marginBottom: '16px',
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

  legend: { display: 'flex', gap: '16px', marginBottom: '4px', flexWrap: 'wrap' as const },
  legendItem: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#6B7280' },
  legendSwatch: { width: '16px', height: '16px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', fontWeight: 700 },

  errorBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px' },
  bannerIcon: { fontSize: '14px' },

  continueBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}