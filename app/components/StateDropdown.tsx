'use client'

import SearchableSelect from './SearchableSelect'
import { INDIAN_STATES_AND_CITIES } from '@/app/lib/data/locations'

// ── StateDropdown ────────────────────────────────────────────────────────────
// The 28 states and 8 union territories, typable.
//
// Not free text, and that is the point: GST registers per state, so the state is
// the thing a GSTIN's first two digits have to agree with. A typed "Mahrashtra"
// could never be cross-checked, so this one stays a closed list.
//
// The GST code sits in the sublabel because it is what someone reconciling a
// certificate against a GSTIN is actually looking for.
// ─────────────────────────────────────────────────────────────────────────────

interface StateDropdownProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export default function StateDropdown({ value, onChange, disabled }: StateDropdownProps) {
  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={INDIAN_STATES_AND_CITIES.map(s => ({
        id: s.state,
        label: s.state,
        sublabel: `GST code ${s.gstCode}`,
      }))}
      selectedLabel={value}
      placeholder="Search states…"
      emptyMessage="No states match"
      disabled={disabled}
    />
  )
}
