'use client'

import { CountrySelect } from '@/app/components/places/PlacePickers'

// ── CountryDropdown ──────────────────────────────────────────────────────────
// The country of an address (client, client group, branch, GST registration),
// stored by its English name ("India") as those records always have been.
//
// Every country in the GeoNames list, not a short hand-made one. Still a
// closed list: the country drives the state list below it, so a saved value
// that is not a country is shown with a note, never silently blanked.
// ─────────────────────────────────────────────────────────────────────────────

interface CountryDropdownProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export default function CountryDropdown({ value, onChange, disabled }: CountryDropdownProps) {
  return <CountrySelect by="name" value={value} onChange={onChange} disabled={disabled} placeholder="Search countries…" />
}
