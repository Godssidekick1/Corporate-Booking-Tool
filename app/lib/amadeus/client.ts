// ── lib/amadeus/client.ts ─────────────────────────────────────────────────────
// Single entry point for all Amadeus API calls.
//
// Responsibilities:
//   - Session management: Login once, cache SessionID, re-auth on expiry
//   - Typed request/response shapes derived from real Postman responses
//   - One method per Amadeus endpoint
//   - All errors throw AmadeusError — callers never see raw Amadeus error shapes
//
// Session caching strategy (MVP):
//   - In-process module-level singleton — works fine on Vercel because each
//     function invocation is warm for the lifetime of the container.
//   - No explicit TTL returned by Amadeus, so we use 25 minutes conservatively
//     (empirically sessions expire around 30 minutes from the "Result Session
//     Expired" error observed in testing).
//   - On any "Session Expired" error from any endpoint, we re-auth once and retry.
//
// ─────────────────────────────────────────────────────────────────────────────
import { getCachedSession, setCachedSession, clearCachedSession } from './sessionStore'

const BASE_URL = (process.env.AMADEUS_API_BASE_URL ?? '').trim().replace(/\/$/, '')
const CLIENT_CODE = (process.env.AMADEUS_CLIENT_CODE ?? '').trim()
const USERNAME = (process.env.AMADEUS_USERNAME ?? '').trim()
const PASSWORD = (process.env.AMADEUS_PASSWORD ?? '').trim()

// ── Error ─────────────────────────────────────────────────────────────────────

export class AmadeusError extends Error {
  constructor(
    message: string,
    public readonly code: string = '',
    public readonly category: string = '',
    public readonly raw?: unknown,
    public readonly requestId?: string,
    public readonly requestBody?: unknown
  ) {
    super(message)
    this.name = 'AmadeusError'
  }
}

function assertSuccess(
  json: AmadeusEnvelope,
  context: string,
  requestId?: string,
  requestBody?: unknown
): void {
  if (json.Status !== 'Success') {
    const desc = json.Error?.Description ?? 'Unknown error'
    const code = json.Error?.ErrorCode ?? ''
    const category = json.Error?.Category ?? ''
    throw new AmadeusError(`Amadeus ${context} failed: ${desc}`, code, category, json, requestId, requestBody)
  }
}

export function sanitizeAmadeusDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAmadeusDiagnostic)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /password|sessionid/i.test(key) ? '[REDACTED]' : sanitizeAmadeusDiagnostic(entry),
    ])
  )
}

function isSessionExpired(json: AmadeusEnvelope): boolean {
  return Boolean(
    json.Status === 'Failure' &&
    (json.Error?.Description?.toLowerCase().includes('session expired') ||
     json.Error?.Description?.toLowerCase().includes('session'))
  )
}

// ── Response shape types ──────────────────────────────────────────────────────
// Derived from real Postman responses. Only fields we actually use are typed;
// additional fields are captured in index signatures.

interface AmadeusError_ {
  ErrorCode: string
  Description: string
  Category: string
}

interface AmadeusEnvelope {
  Status: 'Success' | 'Failure' | string
  Error: AmadeusError_ | null
  [key: string]: unknown
}

// Login
interface LoginResponse extends AmadeusEnvelope {
  SessionID: string
  DateTime: string
}

// FlightAvailability
export interface FlightSegment {
  Origin: string
  Destination: string
  DepartureDateTime: string   // ISO "2026-10-20T13:00:00"
  ArrivalDateTime: string
  Duration: string            // "04:40"
  FlightNumber: string
  AirlineCode: string
  AirlineName: string
  CabinClass: string
  Stops: number
  BaggageAllowance: string
  SeatsAvailable: number
}

export interface LocationInfo {
  AirportCode: string
  AirportName: string
  CityName: string
  Terminal?: string
  DateTime: string
}

export interface AirlineInfo {
  Code: string
  Name: string
  Identification?: string
  OperatingCarrier?: string
}

export interface BaggageAllowance {
  CheckIn: string       // e.g. "15" (kg)
  Cabin: string         // e.g. "7" (kg)
  CheckInPiece: string
  CabinPiece: string
}

// ItineraryInfo matches real Amadeus response shape.
// Segment data lives directly on each Itinerary item, NOT nested under FlightSegments.
export interface ItineraryInfo {
  Conx: { ViaPoint: string; IsChangeOfPlane: string }
  Origin: LocationInfo
  Destination: LocationInfo
  AirLine: AirlineInfo
  Baggage: { Allowance: BaggageAllowance }
  Leg: string
  Flight: string
  StopCount: string     // "0-Stop", "1-Stop" etc — string, not number
  Duration: string      // "02:05"
  AvailableSeats: string  // empty string when not available
  EquipmentType: string
  Cabin: string         // "Y" (booking class code)
  BookingCode: string
  Key: string
}

export interface FareBreakDown {
  TotalFare: string     // string in real response — use Number() when consuming
  BaseFare: string
  TotalTax: string
  Taxes?: unknown
  PaxType: string
  Currency: string
  Refundable: string    // "Refundable" | "Non-Refundable" — string, not boolean
}

export interface FareInfo {
  Cabin: string
  BookingCode: string
  PaxType: string
  PaxCabin: string
  PaxFareBasis: string
  PaxBookingClass: string
}

export interface PricingInfo {
  Currency: string
  Pricingkey: string    // encoded string — pass unchanged to Pricing endpoint
  Meal?: string
  Total: {
    BaseFare: string    // string in real response
    OtherTax: string
    Fare: string        // string in real response — total including tax
    FuelSurcharge: string
    NetFare: string
    CommissionEarned: string
    ServiceFee: string
  }
  FareBreakDowns: { FareBreakDown: FareBreakDown[] }
  FareInfos: { FareInfo: FareInfo[] }
  FareType?: string
  GSTAllowed?: boolean
  IsNDC?: boolean
}

export interface FlightResult {
  IsLCC: string | boolean
  Provider: string
  FlightKey: string
  TotalDuration?: unknown[]
  ItemNo: string
  Itineraries: {
    Itinerary: ItineraryInfo[]
  }
  PricingInfos: {
    PricingInfo: PricingInfo[]
  }
}

export interface AvailibilityWrapper {
  Availibility: FlightResult[]
}

export interface FlightAvailabilityResponse {
  SessionID: string
  Status: string
  Key: string
  Adult: number
  Child: number
  Infant: number
  Trip: string
  TripType: string
  Availibilities: AvailibilityWrapper[]
}

// Pricing
export interface PassengerFareBreakup {
  PaxType: string             // "ADT" | "CHD" | "INF"
  BaseFare: number
  Tax: number
  TotalFare: number
}

// Pricing's response reuses the exact same nested shape as a FlightResult
// from Availability (Itineraries, PricingInfos.PricingInfo[].Total/FareBreakDowns/etc) —
// confirmed against a real response. There is NO flat top-level TotalFare/
// BaseFare/PassengerFareBreakup — those fields live nested under
// AirPricingResponse[0].PricingInfos.PricingInfo[0], same as Availability.
export interface PricingResponse {
  Status: string
  Key: string
  ReferenceNo: string          // "ARRF#####" — store immediately
  Error: AmadeusEnvelope['Error']
  IsPriceChange: boolean
  AirPricingResponse: FlightResult[]  // same shape as Availability's FlightResult — one entry, re-priced
}

// AddPassenger
export interface PassengerDetail {
  Title: string
  Gender: string
  FirstName: string
  MiddleName: string
  LastName: string
  DateOfBirth: string         // "DD/MM/YYYY"
  PaxType: string             // "ADT" | "CHD" | "INF"
  PassportNumber: string
  IssuingCountry: string
  Nationality: string
  ExpiryDate: string          // "DD/MM/YYYY"
  MealCode: string
}

export interface CustomerInfo {
  Email: string
  Mobile: string
  Address: string
  City: string
  State: string
  CountryCode: string
  CountryName: string
  ZipCode: string
  PassengerDetails: PassengerDetail[]
  PassengerTicketDetails: unknown[]
  Payment: Record<string, unknown>
}

export interface AddPassengerResponse {
  Status: string
  Key: string
  ReferenceNo: string
  AirItineries: unknown | null
  CustomerInfo: unknown | null
  Error: AmadeusError_ | null
}

// Booking
export interface BookingResponse {
  Status: string
  ReferenceNo: string
  TransactionID: string
  AirBookingResponse: AirBookingResult[]  // new type below, one entry
  Error: AmadeusEnvelope['Error']
  PaymentDetails: unknown
  SSRDetails: unknown
  GSTRequest: unknown
}

export interface AirBookingResult {
  PNR: string
  BookingStatus: string
  BookingDate: string
  FlightDetails: unknown[]
  FareDetails: unknown
  CustomerInfo: {
    PassengerDetails: { TicketNo?: string }[]
  }
  TrackID: string
  TotalAmount: number
  GrandTotalFare: number
  ProviderDetails: { Tid: string; Status: string }
}

// Ticket
export interface TicketResponse {
  Status: string
  ReferenceNo: string
  TransactionID: string
  AirBookingResponse: AirBookingResult[]
  Error: AmadeusEnvelope['Error']
  PaymentDetails: unknown
  SSRDetails: unknown
  GSTRequest: unknown
}

// GetBookingDetails
export interface BookingDetailsResponse {
  Status: string
  ReferenceNo: string
  PnrNo: string
  AirItineries: unknown
  CustomerInfo: unknown
  Error: AmadeusError_ | null
}

// CancellationRequest
export interface CancellationResponse {
  Status: string
  Key: string
  ReferenceNo: string
  CancelStatus: string
  Remarks: string
  RefundedAmount: number
  CancellationCharge: number
  ServiceTaxOnRAF: number
  TransactionID: string
  TrackIds: string
  Error: AmadeusError_ | null
}

// FareRule
export interface FareRuleResponse {
  Status: string
  Key: string
  FareRules: unknown[]
  Error: AmadeusError_ | null
}

// SeatMap
export interface SeatMapResponse {
  Status: string
  Key: string
  SeatMap: unknown
  Error: AmadeusError_ | null
}

// ── Search input types ────────────────────────────────────────────────────────

export interface SearchSegment {
  Origin: string
  Destination: string
  DepartDate: string          // "DD/MM/YYYY"
}

export interface FlightSearchParams {
  segments: SearchSegment[]
  adult?: number
  child?: number
  infant?: number
  nonStop?: boolean
  preferredClass?: string
  preferredCarrier?: string
  rtf?: boolean
}

// ── Session cache (module-level singleton) ──────────────────────────────────

function generateSearchKey(): string {
  // Client-generated key for the search session — format matches Amadeus examples
  const hex = () => Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4, '0')
  return `${hex()}-${hex()}-${hex()}-${hex()}`
}

// ── Core HTTP helper ──────────────────────────────────────────────────────────

async function post<T extends AmadeusEnvelope>(
  endpoint: string,
  body: Record<string, unknown>,
  requestId: string
): Promise<T> {
 

const url = `${BASE_URL}/${endpoint}`

console.info('[amadeus] request', { requestId, endpoint, body: sanitizeAmadeusDiagnostic(body) })
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new AmadeusError(
      `HTTP ${res.status} from Amadeus ${endpoint}`,
      String(res.status),
      '',
      undefined,
      requestId
    )
  }

  const json = await res.json() as T
  console.info('[amadeus] response', { requestId, endpoint, status: json.Status, error: sanitizeAmadeusDiagnostic(json.Error) })
  return json
}

// ── Session management ────────────────────────────────────────────────────────

async function login(): Promise<string> {
  const requestId = crypto.randomUUID()
  const body = {
    UserName: USERNAME,
    Password: PASSWORD,
  }
  const json = await post<LoginResponse>('flight/Authenticate', body, requestId)

  assertSuccess(json, 'Login', requestId, body)

  await setCachedSession(json.SessionID)

  console.info('[amadeus] new session established', { requestId })
  return json.SessionID
}


async function getSessionId(): Promise<string> {
  const cached = await getCachedSession()
  if (cached && Date.now() < cached.expiresAt) {
    return cached.sessionId
  }
  return login()
}

// ── Retry wrapper — re-auths once on session expiry ──────────────────────────

async function withSession<T extends AmadeusEnvelope>(
  endpoint: string,
  buildBody: (sessionId: string) => Record<string, unknown>,
  context: string,
  options: { acceptedStatuses?: string[] } = {}
): Promise<T> {
  const requestId = crypto.randomUUID()
  const acceptedStatuses = options.acceptedStatuses ?? ['Success']

  // Some Amadeus endpoints use a different vocabulary for "this worked."
  // Booking specifically: PNR creation returns Status: 'Hold' on success —
  // that's the correct terminal state for this step (Ticketing is the step
  // that turns Hold into Success). Treating 'Hold' as a failure here would
  // reject a booking that Amadeus actually placed correctly.
  function checkSuccess(json: AmadeusEnvelope, requestId: string, body: unknown) {
    if (!acceptedStatuses.includes(json.Status)) {
      assertSuccess(json, context, requestId, body) // throws with the real error detail
    }
  }

  const sessionId = await getSessionId()
  const body = buildBody(sessionId)
  const json = await post<T>(endpoint, body, requestId)

  if (isSessionExpired(json) || shouldRefreshAvailabilitySession(json, context)) {
    console.info('[amadeus] refreshing session before one retry', { requestId, endpoint })
    await clearCachedSession()
    const freshSessionId = await getSessionId()
    const retryBody = buildBody(freshSessionId)
    const retryJson = await post<T>(endpoint, retryBody, requestId)
    checkSuccess(retryJson, requestId, retryBody)
    return retryJson
  }

  checkSuccess(json, requestId, body)
  return json
}

// ── Public API ────────────────────────────────────────────────────────────────

export const amadeus = {

  // ── 1. Flight search ───────────────────────────────────────────────────────
  async searchFlights(params: FlightSearchParams): Promise<FlightAvailabilityResponse> {
    const searchKey = generateSearchKey()

    const json = await withSession<AmadeusEnvelope & FlightAvailabilityResponse>(
      'flight/Availability',
      (sessionId) => ({
        Adult: params.adult ?? 1,
        Child: params.child ?? 0,
        Infant: params.infant ?? 0,
        ClientCode: CLIENT_CODE,
        RTF: params.rtf ?? false,
        NonStop: params.nonStop ?? false,
        PreferredClass: params.preferredClass ?? '',
        PreferredCarrier: params.preferredCarrier ?? '',
        SessionID: sessionId,
        Segments: params.segments,
        Key: searchKey,
      }),
      'FlightAvailability'
    )

    return json as FlightAvailabilityResponse
  },

  // ── 2. Pricing ─────────────────────────────────────────────────────────────
  // resultKey: the per-result Key from the FlightAvailability RESPONSE
  // (top-level Key field, shared by the whole search — NOT the per-result
  // FlightKey). pricingKey: the encoded PricingKey string from that same
  // FlightAvailability result.
  async pricing(
    resultKey: string,
    pricingKey: string,
    provider: string,
    resultIndex: string
  ): Promise<PricingResponse> {
    const json = await withSession<AmadeusEnvelope & PricingResponse>(
      'flight/Pricing',
      (sessionId) => ({
        ClientCode: CLIENT_CODE,
        SessionID: sessionId,
        Key: resultKey,
        Pricingkey: pricingKey,
        Provider: provider,
        ResultIndex: resultIndex,
      }),
      'Pricing'
    )

    return json as PricingResponse
  },

  // ── 3. Add passenger ───────────────────────────────────────────────────────
  // referenceNo: from Pricing response
  async addPassenger(
    resultKey: string,
    referenceNo: string,
    customerInfo: CustomerInfo,
    totalAmount: string = '0',
    grandTotalFare: string = '0'
  ): Promise<AddPassengerResponse> {
    const json = await withSession<AmadeusEnvelope & AddPassengerResponse>(
      'Flight/AddPassengerDetails',
      (sessionId) => ({
        ClientCode: CLIENT_CODE,
        SessionID: sessionId,
        Key: resultKey,
        ReferenceNo: referenceNo,
        CustomerInfo: {
          ...customerInfo,
          PassengerTicketDetails: [],
          Payment: {},
        },
        SSRInfo: [],
        TotalAmount: totalAmount,
        SSRAmount: 0,
        Discount: 0,
        GrandTotalFare: grandTotalFare,
        IsGSTProvided: false,
      }),
      'AddPassenger'
    )

    return json as AddPassengerResponse
  },

  // ── 4. Booking ─────────────────────────────────────────────────────────────
  // ── 4. Booking ─────────────────────────────────────────────────────────────
  // Booking is a two-step Amadeus flow: this call creates the PNR and, on
  // success, returns Status: 'Hold' — NOT 'Success'. 'Hold' IS the correct
  // success state here; Ticketing (next step) is what confirms it to 'Success'.
  async booking(
    resultKey: string,
    referenceNo: string,
    provider: string
  ): Promise<BookingResponse> {
    const json = await withSession<AmadeusEnvelope & BookingResponse>(
      'Flight/Booking',
      (sessionId) => ({
        ClientCode: CLIENT_CODE,
        SessionID: sessionId,
        Key: resultKey,
        ReferenceNo: referenceNo,
        Provider: provider,
      }),
      'Booking',
      { acceptedStatuses: ['Hold'] }
    )

    return json as BookingResponse
  },

  // ── 5. Ticket ──────────────────────────────────────────────────────────────
  async ticket(
    resultKey: string,
    referenceNo: string,
    pricingKey: string,
    provider: string,
    pnrNo: string = '',
    ticketNo: string = ''
  ): Promise<TicketResponse> {
    const json = await withSession<AmadeusEnvelope & TicketResponse>(
      'Flight/Ticket',
      (sessionId) => ({
        ClientCode: CLIENT_CODE,
        SessionID: sessionId,
        Key: resultKey,
        Pricingkey: pricingKey,
        ReferenceNo: referenceNo,
        ResultIndex: '1',
        UserID: CLIENT_CODE,
        Provider: provider,
        PNRNO: pnrNo,
        TicketNo: ticketNo,
      }),
      'Ticket'
    )

    return json as TicketResponse
  },

  // ── 6. Get booking details ─────────────────────────────────────────────────
  async getBookingDetails(
    referenceNo: string,
    provider: string,
    options: {
      resultKey?: string
      pnrNo?: string
      firstName?: string
      lastName?: string
      from?: string
      to?: string
    } = {}
  ): Promise<BookingDetailsResponse> {
    const json = await withSession<AmadeusEnvelope & BookingDetailsResponse>(
      'Flight/GetBookingDetails',
      (sessionId) => ({
        SessionID: sessionId,
        ReferenceNo: referenceNo,
        ClientCode: CLIENT_CODE,
        Provider: provider,
        Key: options.resultKey ?? '',
        PnrNo: options.pnrNo ?? '',
        FirstName: options.firstName ?? '',
        LastName: options.lastName ?? '',
        From: options.from ?? '',
        To: options.to ?? '',
      }),
      'GetBookingDetails'
    )

    return json as BookingDetailsResponse
  },

  // ── 7. Cancellation request ────────────────────────────────────────────────
  async cancelBooking(
    resultKey: string,
    referenceNo: string,
    provider: string,
    remarks: string = ''
  ): Promise<CancellationResponse> {
    const json = await withSession<AmadeusEnvelope & CancellationResponse>(
      'Flight/CancelBooking',
      (sessionId) => ({
        ClientCode: CLIENT_CODE,
        SessionID: sessionId,
        Key: resultKey,
        ReferenceNo: referenceNo,
        Provider: provider,
        CancellationRemarks: remarks,
      }),
      'CancellationRequest'
    )

    return json as CancellationResponse
  },

  // ── 8. Fare rule ───────────────────────────────────────────────────────────
  async fareRule(
    resultKey: string,
    pricingKey: string,
    provider: string
  ): Promise<FareRuleResponse> {
    const json = await withSession<AmadeusEnvelope & FareRuleResponse>(
      'flight/Non-LccFareRule',
      (sessionId) => ({
        ClientCode: CLIENT_CODE,
        SessionID: sessionId,
        Key: resultKey,
        Pricingkey: pricingKey,
        Provider: provider,
      }),
      'FareRule'
    )

    return json as FareRuleResponse
  },

  // ── 9. Seat map ────────────────────────────────────────────────────────────
  async seatMap(
    resultKey: string,
    referenceNo: string,
    provider: string,
    origin: string,
    destination: string
  ): Promise<SeatMapResponse> {
    const json = await withSession<AmadeusEnvelope & SeatMapResponse>(
      'flight/SeatMap',
      (sessionId) => ({
        ClientCode: CLIENT_CODE,
        SessionID: sessionId,
        Key: resultKey,
        ReferenceNo: referenceNo,
        UserID: CLIENT_CODE,
        Destination: destination,
        Origin: origin,
        Provider: provider,
      }),
      'SeatMap'
    )

    return json as SeatMapResponse
  },
}

// Red-eye: departure between 22:00 and 05:59 local time.
// DepartureDateTime comes from Amadeus as ISO "2026-10-20T13:00:00" (no tz).
// Treated as local time at origin — good enough for policy enforcement.
export function isRedEye(departureDateTime: string): boolean {
  const hour = new Date(departureDateTime).getHours()
  return hour >= 22 || hour < 6
}

function shouldRefreshAvailabilitySession(json: AmadeusEnvelope, context: string): boolean {
  return context === 'FlightAvailability' &&
    json.Status === 'Failure' &&
    json.Error?.Description?.toLowerCase() === 'something went wrong.'
}