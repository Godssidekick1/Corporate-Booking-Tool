import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { flowStorage, PricedFare } from '@/app/lib/book/flowStorage'
import { FlatFlightResult, formatTime, formatDayLabel } from '@/app/lib/book/types'
import { countryNameFromCode } from '@/app/lib/data/countryCodes'

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

// Age bounds per standard airline convention: adult 12+, child 2-11, infant under 2.
// Checked against today's date as a reasonable proxy for travel date.
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

export default function PassengerDetailsPage() {
  const router = useRouter()
  const params = useParams<{ flightKey: string }>()
  const flightKey = decodeURIComponent(params.flightKey)

  const [flight, setFlight] = useState<FlatFlightResult | null>(null)
  const [priced, setPriced] = useState<PricedFare | null>(null)
  const [loadError, setLoadError] = useState('')

  const [passengers, setPassengers] = useState<PassengerForm[]>([])
  const [email, setEmail] = useState('')
  const [mobile, setMobile] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zipCode, setZipCode] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

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
  }, [flightKey])

  function updatePassenger<K extends keyof PassengerForm>(index: number, key: K, value: PassengerForm[K]) {
    setPassengers(prev => prev.map((p, i) => i === index ? { ...p, [key]: value } : p))
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
            PassengerDetails: passengers.map(p => ({
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
              ? `Enter details for all ${passengers.length} travelers, exactly as they appear on their ID.`
              : 'Enter details exactly as they appear on the traveler\u2019s ID.'}
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
          {passengers.map((passenger, i) => (
            <div style={s.card} key={i}>
              <h2 style={s.cardTitle}>
                Traveler {passengers.length > 1 ? `${i + 1} of ${passengers.length}` : ''}
                <span style={s.paxTypeBadge}>{PAX_TYPE_LABEL[passenger.paxType]}</span>
              </h2>

              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>Title</label>
                  <select value={passenger.title} onChange={e => updatePassenger(i, 'title', e.target.value)} style={s.input}>
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
                  <select value={passenger.gender} onChange={e => updatePassenger(i, 'gender', e.target.value)} style={s.input}>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </div>
                <div style={s.field}>
                  <label style={s.label}>Date of birth</label>
                  <input
                    type="date" required value={passenger.dateOfBirth}
                    onChange={e => updatePassenger(i, 'dateOfBirth', e.target.value)}
                    style={{ ...s.input, borderColor: fieldErrors[`passenger-${i}-dob`] ? '#DC2626' : undefined }}
                  />
                  {fieldErrors[`passenger-${i}-dob`] && (
                    <p style={s.fieldError}>{fieldErrors[`passenger-${i}-dob`]}</p>
                  )}
                </div>
              </div>

              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>First name</label>
                  <input type="text" required value={passenger.firstName} onChange={e => updatePassenger(i, 'firstName', e.target.value)} style={s.input} placeholder="As on ID" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Middle name</label>
                  <input type="text" value={passenger.middleName} onChange={e => updatePassenger(i, 'middleName', e.target.value)} style={s.input} />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Last name</label>
                  <input type="text" required value={passenger.lastName} onChange={e => updatePassenger(i, 'lastName', e.target.value)} style={s.input} placeholder="As on ID" />
                </div>
              </div>

              <div style={s.grid3}>
                <div style={s.field}>
                  <label style={s.label}>Passport number</label>
                  <input type="text" required value={passenger.passportNumber} onChange={e => updatePassenger(i, 'passportNumber', e.target.value)} style={s.input} />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Issuing country</label>
                  <input type="text" required value={passenger.issuingCountry} onChange={e => updatePassenger(i, 'issuingCountry', e.target.value.toUpperCase())} style={s.input} maxLength={2} placeholder="IN" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Nationality</label>
                  <input type="text" required value={passenger.nationality} onChange={e => updatePassenger(i, 'nationality', e.target.value.toUpperCase())} style={s.input} maxLength={2} placeholder="IN" />
                </div>
              </div>

              <div style={s.field}>
                <label style={s.label}>Passport expiry</label>
                <input type="date" required value={passenger.expiryDate} onChange={e => updatePassenger(i, 'expiryDate', e.target.value)} style={s.input} />
              </div>
            </div>
          ))}

          {/* ── Contact details (shared, not per-passenger) ─────────── */}
          <div style={s.card}>
            <h2 style={s.cardTitle}>Contact details</h2>
            <p style={s.cardSub}>We'll send booking confirmations and updates here.</p>

            <div style={s.grid2}>
              <div style={s.field}>
                <label style={s.label}>Email</label>
                <input
                  type="email" required value={email} onChange={e => setEmail(e.target.value)}
                  style={{ ...s.input, borderColor: fieldErrors['contact-email'] ? '#DC2626' : undefined }}
                />
                {fieldErrors['contact-email'] && <p style={s.fieldError}>{fieldErrors['contact-email']}</p>}
              </div>
              <div style={s.field}>
                <label style={s.label}>Mobile</label>
                <input
                  type="tel" required value={mobile} onChange={e => setMobile(e.target.value)}
                  style={{ ...s.input, borderColor: fieldErrors['contact-mobile'] ? '#DC2626' : undefined }}
                  placeholder="10-digit number"
                />
                {fieldErrors['contact-mobile'] && <p style={s.fieldError}>{fieldErrors['contact-mobile']}</p>}
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>Address</label>
              <input type="text" required value={address} onChange={e => setAddress(e.target.value)} style={s.input} />
            </div>

            <div style={s.grid3}>
              <div style={s.field}>
                <label style={s.label}>City</label>
                <input type="text" required value={city} onChange={e => setCity(e.target.value)} style={s.input} />
              </div>
              <div style={s.field}>
                <label style={s.label}>State</label>
                <input type="text" required value={state} onChange={e => setState(e.target.value)} style={s.input} />
              </div>
              <div style={s.field}>
                <label style={s.label}>ZIP code</label>
                <input type="text" required value={zipCode} onChange={e => setZipCode(e.target.value)} style={s.input} />
              </div>
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

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '640px', margin: '0 auto', padding: '32px 24px 64px' },

  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },

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

  paxTypeBadge: { fontSize: '10px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', padding: '2px 8px', borderRadius: '5px', letterSpacing: '0.3px' },

  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '12px' },
  label: { fontSize: '11px', fontWeight: 500, color: '#374151' },
  input: { height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '7px', outline: 'none' },
  fieldError: { fontSize: '10.5px', color: '#DC2626', margin: '2px 0 0' },

  errorBanner: { display: 'flex', alignItems: 'center', gap: '8px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '11px 14px', fontSize: '13px', color: '#DC2626', marginBottom: '16px' },
  bannerIcon: { fontSize: '14px' },

  continueBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}