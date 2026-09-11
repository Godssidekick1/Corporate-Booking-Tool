'use client'

// ── Shared pieces of the Corporate Settings screen ───────────────────────────
// The client shape, the labelled grid cell, and one style object.
//
// Extracted when the page went from accordion to tabs and the two heavy tabs —
// GST registrations and Allocations — became their own files. Three copies of
// `input` drifting apart is how one tab ends up with taller boxes than the next.
// ─────────────────────────────────────────────────────────────────────────────

export interface Client {
  id: string
  name: string
  status: string
  setup_completed: boolean
  timezone: string
  currency: string
  country: string | null
  booking_mode: 'sbt' | 'cbt' | 'both'
  client_group_id: string | null
  created_at: string
  registered_address: string | null
  industry: string | null
  primary_contact_phone: string | null
  size: string | null
  managed_by: string | null
  branch_id: string | null
  client_code: string | null
  sap_customer_code: string | null
  sap_group_code: string | null
  email: string | null
  phone: string | null
  address_1: string | null
  address_2: string | null
  city: string | null
  state: string | null
  pincode: string | null
  collections_name: string | null
  collections_email: string | null
  collections_mobile: string | null
  booking_activation: boolean
  hold_activation: boolean
  dom_ticketing: boolean
  intl_ticketing: boolean
  hold_auto_issue: boolean
  sbt_ticketing: boolean
  policy_controlling: boolean
  personal_bookings_allowed: boolean
  agency_fop_allowed: boolean
  corporate_fop_allowed: boolean
  // "Traveller pays" split in two. See app/lib/fop/paymentTypes.ts — in this
  // product BTA/CTA means the traveller's own card, not a corporate account.
  bta_cta_allowed: boolean
  bta_cta_manual_allowed: boolean
  // Preference order over all four payment types, most preferred first.
  fop_priority: string[]
  discount_active: boolean
  processing_fee_active: boolean
  air_approval_mode: string
  hotel_approval_mode: string
}

// The generic setter every tab uses. Declared once so a tab cannot accidentally
// take a narrower one and stop marking the form dirty.
export type SetField = <K extends keyof Client>(key: K, value: Client[K]) => void

// ── Field ────────────────────────────────────────────────────────────────────
// A labelled cell in the section grid. `span` widens one across the three-column
// layout for the fields that genuinely need the room, like an address line.
export function Field({ label, hint, span = 1, children }: {
  label: string
  hint?: string
  span?: number
  children: React.ReactNode
}) {
  return (
    <div style={{ ...s.field, gridColumn: `span ${span}` }}>
      <label style={s.label}>{label}</label>
      {children}
      {hint && <span style={s.fieldHint}>{hint}</span>}
    </div>
  )
}

export const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: 1040, margin: '0 auto', padding: '32px 40px 96px' },
  header: { marginBottom: 18 },
  backLink: { fontSize: 12, color: '#6B7280', textDecoration: 'none' },
  heading: { fontSize: 21, fontWeight: 600, color: '#0A0A14', margin: '8px 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  // The identity strip above the tabs. Whose settings these are has to stay on
  // screen — a tab row is easy to lose your place in.
  idStrip: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 16px', paddingBottom: 14, borderBottom: '1px solid #F3F4F6' },
  idChip: { fontSize: 11.5, color: '#6B7280' },
  idChipStrong: { fontSize: 11.5, color: '#111827', fontWeight: 600 },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, fontWeight: 600, color: '#374151' },
  fieldHint: { fontSize: 10.5, color: '#9CA3AF', lineHeight: 1.5 },
  input: {
    height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff',
    border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none', boxSizing: 'border-box',
  },
  readOnly: { background: '#F3F4F6', color: '#6B7280', cursor: 'not-allowed' },
  mono: { fontFamily: 'var(--font-mono)' },

  toggles: { display: 'flex', flexDirection: 'column' },
  subLabel: { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '22px 0 6px' },
  blockDesc: { fontSize: 12, color: '#6B7280', lineHeight: 1.6, margin: '0 0 10px', maxWidth: 620 },
  hint: { fontSize: 12, color: '#6B7280', lineHeight: 1.6, margin: '6px 0 0' },
  inlineLink: { color: '#3730A3', textDecoration: 'underline', textUnderlineOffset: 2 },
  muted: { color: '#9CA3AF', fontSize: 11.5 },

  linkList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  linkItem: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 7 },
  linkName: { fontSize: 12.5, fontWeight: 600, color: '#111827' },

  legacyNote: { fontSize: 11.5, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 7, padding: '10px 12px', margin: '14px 0 0', lineHeight: 1.6 },
  warnNote: { fontSize: 11.5, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 7, padding: '9px 12px', margin: '10px 0 0', lineHeight: 1.6 },
  successNote: { fontSize: 12, color: '#065F46', background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 7, padding: '9px 12px', margin: '12px 0 0' },

  tableWrap: { border: '1px solid #E5E7EB', borderRadius: 8, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%', minWidth: 720 },
  th: { padding: '8px 10px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 10.5, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  td: { padding: '8px 10px', fontSize: 12, color: '#374151', borderBottom: '1px solid #F3F4F6', whiteSpace: 'nowrap' },
  tdExpired: { color: '#9CA3AF' },

  actions: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#374151' },
  primaryBtn: { height: 34, padding: '0 14px', background: '#000835', color: '#fff', fontSize: 12.5, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
  ghostBtn: { height: 28, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 11.5, border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer', marginLeft: 'auto' },
  smallBtn: { height: 26, padding: '0 9px', background: '#fff', color: '#374151', fontSize: 11, border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer' },
  dangerBtn: { fontSize: 11, color: '#DC2626', background: 'transparent', border: '1px solid #FECACA', borderRadius: 5, padding: '3px 8px', cursor: 'pointer' },

  warnBadge: { fontSize: 10, fontWeight: 600, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '1px 6px' },
  countBadge: { fontSize: 10, fontWeight: 600, color: '#3730A3', background: '#EEF2FF', borderRadius: 10, padding: '1px 7px' },
  pill: { fontSize: 10, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', borderRadius: 4, padding: '1px 6px' },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },
  error: { fontSize: 13, color: '#DC2626' },

  stickyBar: {
    position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30,
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14,
    padding: '12px 40px', background: '#fff', borderTop: '1px solid #E5E7EB',
    boxShadow: '0 -4px 16px rgba(0,0,0,0.06)',
  },
  stickyText: { fontSize: 12, color: '#92400E' },
  stickyBtn: { height: 36, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
}
