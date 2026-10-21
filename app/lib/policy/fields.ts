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
  // One plain line under the label, in the editor.
  help?: string
  // Shown beside another field's input rather than as its own row (the
  // grace's unit, next to the grace).
  inlineWith?: string
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
// the fare caps (with their grace), both cabins, carrier tier, advance
// booking, refundable fare, max stops, max journey time, max layover, max
// cancellation fee and the seat-fee cap.
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

// How the fare caps' grace is counted: a share of the cap, or a fixed amount.
// A share suits a group with both caps: ₹500 means little on a ₹60,000 cap.
export const GRACE_UNIT_OPTIONS: TierOption[] = [
  { label: '% of the cap', value: 0 },
  { label: '₹ over the cap', value: 1 },
]

// Whether a within-policy booking goes for approval, for this group's bands.
// Not set: the company's Corporate Setting decides, and if that is not set
// either, approved automatically (app/lib/rule-engine/withinPolicyApproval.ts).
export const WITHIN_POLICY_OPTIONS: TierOption[] = [
  { label: 'Approved automatically', value: 0 },
  { label: 'Sent for approval', value: 1 },
]

// "Any" is 3: no itinerary we are offered has more, so it never fires.
export const STOP_OPTIONS: TierOption[] = [
  { label: 'Non-stop only', value: 0 },
  { label: 'Up to 1 stop',  value: 1 },
  { label: 'Up to 2 stops', value: 2 },
  { label: 'Any',           value: 3 },
]

export const CATEGORIES: CategoryDef[] = [
  // Flights, in the order someone filling a policy thinks about them. Five
  // sections rather than one row of twenty columns; the keys are unchanged.
  {
    id: 'flight', label: 'Fares', color: '#EEF2FF', textColor: '#3730A3',
    description: 'What a flight may cost. Over a cap but within the grace: needs approval. Beyond it: out of policy.',
    fields: [
      { key: 'max_fare_domestic',           label: 'Max domestic fare',         unit: '₹',    kind: 'numeric', travelType: 'flight',
        help: 'The whole booking, as the company pays it. Empty: no cap.' },
      { key: 'max_fare_intl',               label: 'Max international fare',    unit: '₹',    kind: 'numeric', travelType: 'flight',
        help: 'The whole booking, as the company pays it. Empty: no cap.' },
      { key: 'fare_grace',                  label: 'Grace above the cap',                     kind: 'numeric', travelType: 'flight',
        help: 'A fare within the grace always goes for approval. A share of the cap suits a group with both caps.' },
      { key: 'fare_grace_unit',             label: 'Grace counted as',                        kind: 'tier',    travelType: 'flight', options: GRACE_UNIT_OPTIONS,
        inlineWith: 'fare_grace' },
      { key: 'lowest_fare_window_minutes',  label: 'Lowest fare window (±)',    unit: 'min',  kind: 'numeric', travelType: 'flight', wholeNumber: true,
        help: 'A cheaper flight departing within this many minutes means the booking needs approval. Empty: not checked.' },
      { key: 'max_seat_selection_fee',      label: 'Max seat selection spend',  unit: '₹',    kind: 'numeric', travelType: 'flight',
        help: '0: no paid seats. Empty: no cap.' },
    ],
  },
  {
    id: 'flight_cabin', label: 'Cabin & airline', color: '#EEF2FF', textColor: '#3730A3',
    fields: [
      { key: 'cabin_class_short_haul',      label: 'Cabin (up to 8 h)',                       kind: 'tier',    travelType: 'flight', options: CABIN_CLASS_OPTIONS,
        help: 'The highest cabin allowed. Above it: out of policy.' },
      { key: 'cabin_class_long_haul',       label: 'Cabin (over 8 h)',                        kind: 'tier',    travelType: 'flight', options: CABIN_CLASS_OPTIONS,
        help: 'Judged on the longest direction of the trip.' },
      { key: 'carrier_tier',                label: 'Carrier tier',                            kind: 'tier',    travelType: 'flight', options: CARRIER_OPTIONS,
        help: 'Budget only: a full-service airline is out of policy.' },
    ],
  },
  {
    id: 'flight_route', label: 'Routing & timing', color: '#EEF2FF', textColor: '#3730A3',
    fields: [
      { key: 'max_stops',                   label: 'Max stops (each way)',                    kind: 'tier',    travelType: 'flight', options: STOP_OPTIONS },
      { key: 'max_journey_hours',           label: 'Max journey time (each way)', unit: 'h',  kind: 'numeric', travelType: 'flight',
        help: 'Door to door in one direction, layovers included.' },
      { key: 'max_layover_hours',           label: 'Max layover (any stop)',    unit: 'h',    kind: 'numeric', travelType: 'flight' },
      { key: 'advance_booking_days',        label: 'Book at least',             unit: 'days', kind: 'numeric', travelType: 'flight', wholeNumber: true,
        help: 'Days ahead of departure. A later booking is out of policy.' },
      { key: 'red_eye_restricted',          label: 'Red-eye flights restricted',              kind: 'boolean', travelType: 'flight',
        help: 'Stored, not yet checked.' },
    ],
  },
  {
    id: 'flight_conditions', label: 'Fare conditions', color: '#EEF2FF', textColor: '#3730A3',
    fields: [
      { key: 'refundable_fare_required',    label: 'Refundable fare required',                kind: 'boolean', travelType: 'flight' },
      { key: 'max_cancel_penalty',          label: 'Max cancellation fee',      unit: '₹',    kind: 'numeric', travelType: 'flight',
        help: 'A non-refundable fare counts as losing the whole fare. A fee given in another currency or in words is not checked.' },
      { key: 'baggage_extra_bags',          label: 'Extra bags allowed',        unit: 'bags', kind: 'numeric', travelType: 'flight', wholeNumber: true,
        help: 'Stored, not yet checked (no bags are sold yet).' },
    ],
  },
  {
    id: 'booking_rights', label: 'Approval & who may book', color: '#F5F3FF', textColor: '#4C1D95',
    description: "For the bands this group covers. A company's own Corporate Settings, when set, override these.",
    fields: [
      { key: 'within_policy_approval',      label: 'Within-policy bookings',                  kind: 'tier',    travelType: 'flight', options: WITHIN_POLICY_OPTIONS,
        help: 'Not set: approved automatically. Needs-approval and out-of-policy fares always go for approval.' },
      { key: 'personal_trips_allowed',      label: 'Personal trips allowed',                  kind: 'boolean', travelType: 'flight',
        help: 'Only where the company allows personal trips at all.' },
      { key: 'guest_bookings_allowed',      label: 'Guest bookings allowed',                  kind: 'boolean', travelType: 'flight', defaultBool: true,
        help: 'Only where the company allows guest bookings at all.' },
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
  // The approval thresholds (auto_approve_under, finance_approval_over) were
  // removed on 2026-10-20: what a trip costs overall is expense management's
  // question. Rows already stored are not read, and drop out on the next save.
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
