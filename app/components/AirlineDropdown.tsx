'use client'

import SearchableSelect from './SearchableSelect'
import { useLookup } from '@/app/hooks/useLookup'
import { AIRLINE_CODE_PATTERN } from '@/app/lib/reference/airlineCode'

// ── AirlineDropdown ──────────────────────────────────────────────────────────
// Picks a carrier for a deal code or a form of payment.
//
// Both fields were a bare <input maxLength={2}> that only uppercased what you
// typed. These are commercial instruments: a deal code filed against 6F when 6E
// was meant does not fail loudly, it just silently never applies. A picker makes
// the right code the easy one.
//
// AN AIRLINE IS A SUGGESTION, NOT A WHITELIST — the same call CityDropdown
// makes, for a sharper reason. The list is harvested from search responses, so a
// carrier nobody has searched yet is legitimately absent. Gating on it would
// make the first deal code for a new airline a deadlock: it cannot be configured
// until it has been flown, and nobody flies it until it is configured. So an
// unlisted code is kept, shown, and flagged — never discarded.
//
// The id IS the code. There is no separate key, which is what lets a free-typed
// value round-trip unchanged.
// ─────────────────────────────────────────────────────────────────────────────

interface AirlineDropdownProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  // Blank means "every airline" on a form of payment, and the placeholder should
  // say so rather than implying something is missing.
  placeholder?: string
}

export default function AirlineDropdown({
  value, onChange, disabled, placeholder = 'Any airline',
}: AirlineDropdownProps) {
  const lookup = useLookup('/api/reference/airlines', value, {
    toOption: row => ({
      id: String(row.code),
      // Code first: it is what goes on the ticket and what a counsellor says out
      // loud. The name is the confirmation that you picked the right one.
      label: String(row.code),
      sublabel: row.name && row.name !== row.code ? String(row.name) : undefined,
    }),
  })

  // Only flagged once it is a plausible code we have simply never seen. Warning
  // on a half-typed "A" would fire on every keystroke.
  const unlisted =
    value !== '' &&
    AIRLINE_CODE_PATTERN.test(value) &&
    !lookup.selectedLabel

  return (
    <div>
      <SearchableSelect
        value={value}
        onChange={code => onChange(code.trim().toUpperCase())}
        options={lookup.options}
        onSearch={lookup.onSearch}
        loading={lookup.loading}
        // Falls back to the raw value so a free-typed code still shows in the
        // closed field, rather than blanking because it matched no row.
        selectedLabel={lookup.selectedLabel || value}
        allowFreeText
        disabled={disabled}
        placeholder={placeholder}
        emptyMessage="No match — type the two-character code"
      />
      {unlisted && (
        <p style={noteStyle}>
          &ldquo;{value}&rdquo; isn&rsquo;t one we&rsquo;ve seen in a search yet. It has been kept —
          check the code.
        </p>
      )}
    </div>
  )
}

const noteStyle: React.CSSProperties = {
  fontSize: 11, color: '#92400E', margin: '4px 0 0',
}
