// ── Policy field definitions ─────────────────────────────────────────────────
// The single vocabulary of policy limits, shared by the TMC editor
// (app/tmc/configurations/policy) and the corporate read-only view
// (app/settings/policy).
//
// These two screens previously each carried their own copy of this list and had
// already drifted — the corporate one used `cabin_class_short` where the TMC
// writes `cabin_class_short_haul`, so those columns could never display a value
// the TMC had set. Keys here must match what lands in policy_rules.limit_key,
// and both screens now derive from this one list so they cannot diverge again.
// ─────────────────────────────────────────────────────────────────────────────

// 'list' holds codes (policy_rules.limit_list): airline codes or fare types.
import { FARE_TYPE_LABEL } from './fareTypes'

export type FieldKind = 'numeric' | 'boolean' | 'tier' | 'list'

export interface TierOption {
  label: string
  value: number
}

export interface FieldDef {
  key: string
  label: string
  unit?: string
  kind: FieldKind
  travelType: string
  options?: TierOption[]
  // Whole-number fields (star ratings, day counts, bag counts) round on entry.
  // Currency/₹ fields are left decimal-friendly since paise amounts are valid.
  wholeNumber?: boolean
  // For 'list' fields: what the codes are, which decides the picker.
  listOf?: 'airlines' | 'fare_types'
  help?: string
  // For 'boolean' fields: the value a group has until someone sets it (the
  // editor shows it, bookingRights enforces it). Absent = No.
  defaultBool?: boolean
}

export interface CategoryDef {
  id: string
  label: string
  description?: string
  color: string
  textColor: string
  fields: FieldDef[]
}

export const CABIN_CLASS_OPTIONS: TierOption[] = [
  { label: 'Economy',         value: 0 },
  { label: 'Premium Economy', value: 1 },
  { label: 'Business',        value: 2 },
  { label: 'First',           value: 3 },
]

// What a booking is checked against (evaluateBooking + buildPolicyInputs):
// the fare caps, both cabins, carrier tier, advance booking, refundable fare,
// max stops, max journey time, the seat-fee cap and the approval thresholds.
// Blocked airlines and allowed fare types are not a verdict at all: those
// fares are left out of the traveller's search (app/lib/policy/searchFilter.ts).
// Personal trips and guest bookings are not a verdict either: with the
// company's switch they decide whether such a booking may be made at all
// (app/lib/rule-engine/bookingRights.ts).
// Stored but not yet checked: extra bags, red-eye, and every hotel, ground and
// general field (nothing books those yet).
export const CARRIER_OPTIONS: TierOption[] = [
  { label: 'Budget only',  value: 0 },
  { label: 'Full-service', value: 1 },
]

// "Any" is 3: no itinerary we are offered has more, so it never fires.
export const STOP_OPTIONS: TierOption[] = [
  { label: 'Non-stop only', value: 0 },
  { label: 'Up to 1 stop',  value: 1 },
  { label: 'Up to 2 stops', value: 2 },
  { label: 'Any',           value: 3 },
]

export const CATEGORIES: CategoryDef[] = [
  {
    id: 'flight', label: 'Flights', color: '#EEF2FF', textColor: '#3730A3',
    fields: [
      { key: 'max_fare_domestic',           label: 'Max domestic fare',         unit: '₹',    kind: 'numeric', travelType: 'flight' },
      { key: 'max_fare_intl',               label: 'Max international fare',    unit: '₹',    kind: 'numeric', travelType: 'flight' },
      { key: 'cabin_class_short_haul',      label: 'Cabin class (short haul)',                kind: 'tier',    travelType: 'flight', options: CABIN_CLASS_OPTIONS },
      { key: 'cabin_class_long_haul',       label: 'Cabin class (long haul >8h)',             kind: 'tier',    travelType: 'flight', options: CABIN_CLASS_OPTIONS },
      { key: 'max_seat_selection_fee',      label: 'Max seat selection spend',  unit: '₹',    kind: 'numeric', travelType: 'flight' },
      { key: 'carrier_tier',                label: 'Carrier tier',                            kind: 'tier',    travelType: 'flight', options: CARRIER_OPTIONS },
      { key: 'advance_booking_days',        label: 'Min. advance booking',      unit: 'days', kind: 'numeric', travelType: 'flight', wholeNumber: true },
      { key: 'baggage_extra_bags',          label: 'Extra bags allowed',        unit: 'bags', kind: 'numeric', travelType: 'flight', wholeNumber: true },
      { key: 'refundable_fare_required',    label: 'Refundable fare required',                kind: 'boolean', travelType: 'flight' },
      { key: 'max_stops',                   label: 'Max stops (each way)',                    kind: 'tier',    travelType: 'flight', options: STOP_OPTIONS },
      { key: 'max_journey_hours',           label: 'Max journey time (each way)', unit: 'h',  kind: 'numeric', travelType: 'flight' },
      { key: 'red_eye_restricted',          label: 'Red-eye flights restricted',              kind: 'boolean', travelType: 'flight' },
      { key: 'personal_trips_allowed',      label: 'Personal trips allowed',                  kind: 'boolean', travelType: 'flight' },
      { key: 'guest_bookings_allowed',      label: 'Guest bookings allowed',                  kind: 'boolean', travelType: 'flight', defaultBool: true },
    ],
  },
  {
    id: 'flight_lists', label: 'Airlines & fare types', color: '#EFF6FF', textColor: '#1E3A8A',
    description: 'Blocked airlines and fare types outside the allowed list are not shown to these travellers at all.',
    fields: [
      { key: 'blocked_airlines',   label: 'Blocked airlines',   kind: 'list', travelType: 'flight', listOf: 'airlines',
        help: 'Never shown in search, and refused if booked another way.' },
      { key: 'preferred_airlines', label: 'Preferred airlines', kind: 'list', travelType: 'flight', listOf: 'airlines',
        help: 'Marked "Preferred" in search results.' },
      { key: 'allowed_fare_types', label: 'Allowed fare types', kind: 'list', travelType: 'flight', listOf: 'fare_types',
        help: 'None ticked: every fare type is allowed.' },
    ],
  },
  {
    id: 'hotel', label: 'Hotels', color: '#F0FDF4', textColor: '#14532D',
    fields: [
      { key: 'max_rate_major_city', label: 'Max rate (major city)', unit: '₹/night', kind: 'numeric', travelType: 'hotel' },
      { key: 'max_rate_other_city', label: 'Max rate (other city)', unit: '₹/night', kind: 'numeric', travelType: 'hotel' },
      { key: 'max_hotel_stars',     label: 'Max hotel stars',       unit: '★',       kind: 'numeric', travelType: 'hotel', wholeNumber: true },
      { key: 'breakfast_included',  label: 'Breakfast included',                     kind: 'boolean', travelType: 'hotel' },
    ],
  },
  {
    id: 'car', label: 'Ground transport', color: '#FFF7ED', textColor: '#7C2D12',
    description: 'Set a cap for self-booked rentals, and whether client-arranged transport is a separate option.',
    fields: [
      { key: 'max_car_rate_per_day',        label: 'Max self-arranged car rental rate', unit: '₹/day', kind: 'numeric', travelType: 'car' },
      { key: 'sponsored_transport_allowed', label: 'Client-arranged transport allowed',                kind: 'boolean', travelType: 'car' },
    ],
  },
  {
    id: 'general', label: 'General', color: '#F5F3FF', textColor: '#4C1D95',
    fields: [
      { key: 'per_diem_allowance', label: 'Per-diem allowance', unit: '₹/day', kind: 'numeric', travelType: 'general' },
      { key: 'max_trip_duration',  label: 'Max trip duration',  unit: 'days',  kind: 'numeric', travelType: 'general', wholeNumber: true },
    ],
  },
  {
    id: 'approval', label: 'Approval thresholds', color: '#F9FAFB', textColor: '#374151',
    fields: [
      { key: 'auto_approve_under',    label: 'Auto-approve under',             unit: '₹', kind: 'numeric', travelType: 'approval' },
      { key: 'finance_approval_over', label: 'Finance approval required over', unit: '₹', kind: 'numeric', travelType: 'approval' },
    ],
  },
]

export const ALL_FIELDS: FieldDef[] = CATEGORIES.flatMap(c => c.fields)

export const FIELD_BY_KEY: Record<string, FieldDef> =
  Object.fromEntries(ALL_FIELDS.map(f => [f.key, f]))

// Each boolean field's value before a group sets it.
export const FIELD_DEFAULTS: Record<string, boolean> =
  Object.fromEntries(ALL_FIELDS.filter(f => f.kind === 'boolean').map(f => [f.key, f.defaultBool ?? false]))

// ── formatFieldValue ─────────────────────────────────────────────────────────
// Renders a stored limit for display. Used by the corporate read-only view,
// where every cell is text rather than an input.
// ─────────────────────────────────────────────────────────────────────────────
export function formatFieldValue(
  field: FieldDef,
  value: number | boolean | string[] | null | undefined
): string {
  if (value === null || value === undefined) return '—'

  if (Array.isArray(value)) {
    if (value.length === 0) return '—'
    return field.listOf === 'fare_types' ? value.map(v => FARE_TYPE_LABEL[v] ?? v).join(', ') : value.join(', ')
  }

  if (field.kind === 'boolean') return value ? 'Yes' : 'No'

  if (field.kind === 'tier') {
    return field.options?.find(o => o.value === Number(value))?.label ?? String(value)
  }

  return Number(value).toLocaleString()
}
