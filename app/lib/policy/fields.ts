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

export type FieldKind = 'numeric' | 'boolean' | 'tier'

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

// NOTE: an older comment here claimed carrier_tier, red_eye_restricted,
// refundable_fare_required, connecting_flights_allowed and
// personal_trips_allowed were not read by evaluateBooking.ts. That is no
// longer true — all five appear in BOOLEAN_ENTITLEMENT_KEYS / TIER_LIMIT_KEYS
// and are enforced. The one key that genuinely never fires is `seat_selection`
// in TIER_LIMIT_KEYS, which has no matching field here; see the note beside it
// in evaluateBooking.ts.
export const CARRIER_OPTIONS: TierOption[] = [
  { label: 'Budget only',  value: 0 },
  { label: 'Full-service', value: 1 },
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
      { key: 'connecting_flights_allowed',  label: 'Connecting flights allowed',              kind: 'boolean', travelType: 'flight' },
      { key: 'red_eye_restricted',          label: 'Red-eye flights restricted',              kind: 'boolean', travelType: 'flight' },
      { key: 'personal_trips_allowed',      label: 'Personal trips allowed',                  kind: 'boolean', travelType: 'flight' },
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

// ── formatFieldValue ─────────────────────────────────────────────────────────
// Renders a stored limit for display. Used by the corporate read-only view,
// where every cell is text rather than an input.
// ─────────────────────────────────────────────────────────────────────────────
export function formatFieldValue(
  field: FieldDef,
  value: number | boolean | null | undefined
): string {
  if (value === null || value === undefined) return '—'

  if (field.kind === 'boolean') return value ? 'Yes' : 'No'

  if (field.kind === 'tier') {
    return field.options?.find(o => o.value === Number(value))?.label ?? String(value)
  }

  return Number(value).toLocaleString()
}
