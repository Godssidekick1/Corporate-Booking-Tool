// ── Traveller-profile formats ────────────────────────────────────────────────
// Browser-safe (no database): the date-picker conversions and title→gender rule
// every profile form shares -- Traveller profiles, the employee's own profile
// and the booking passenger form.
// ─────────────────────────────────────────────────────────────────────────────

// Profiles store dates as DD/MM/YYYY, the format the airline's PassengerDetail
// takes. A date input speaks YYYY-MM-DD. Some older records already hold
// YYYY-MM-DD (an earlier import), so those are read as they are; saving from
// the picker writes them back as DD/MM/YYYY.
export function toDateInput(value: string | undefined | null): string {
  const v = (value ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : ''
}

export function fromDateInput(yyyymmdd: string): string {
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

// Today as YYYY-MM-DD, for a date input's max (a birth date) or min (an expiry).
export function todayInput(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// How people write nationalities ("Indian"), for values typed before the
// country picker existed: the server converts them on save, and the picker
// shows them as the country rather than flagging them. The picker sends codes.
const DEMONYMS: Record<string, string> = {
  indian: 'IN', american: 'US', british: 'GB', emirati: 'AE', singaporean: 'SG',
  nepali: 'NP', nepalese: 'NP', 'sri lankan': 'LK', bangladeshi: 'BD', bhutanese: 'BT',
  canadian: 'CA', australian: 'AU', german: 'DE', french: 'FR', japanese: 'JP',
  chinese: 'CN', malaysian: 'MY', thai: 'TH', saudi: 'SA', omani: 'OM', qatari: 'QA',
}

export function countryForDemonym(value: string): string | null {
  return DEMONYMS[value.trim().toLowerCase()] ?? null
}

// The gender a title implies, to fill the gender field in as the title is
// chosen. MR and MSTR (a boy) are male; MRS and MS are female. Still editable:
// it is a convenience, not a rule.
export function genderForTitle(title: string): 'Male' | 'Female' | null {
  const t = title.trim().toUpperCase()
  if (t === 'MR' || t === 'MSTR') return 'Male'
  if (t === 'MRS' || t === 'MS' || t === 'MISS') return 'Female'
  return null
}
