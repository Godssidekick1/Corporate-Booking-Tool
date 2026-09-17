// ── Special meal codes ───────────────────────────────────────────────────────
// What goes in PassengerDetail.MealCode on AddPassengerDetails.
//
// Until now that field was sent as '' for every passenger on every booking,
// hardcoded — while /profile collected a meal preference, stored it, and loaded
// it to autofill the booking form. Nobody has ever been served the meal they
// asked for.
//
// EVIDENCE. A real AddPassengerDetails request carries "MealCode": "VGML", so
// the provider takes IATA special-meal codes rather than friendly labels. VGML
// is the only code directly evidenced; the rest are the IATA standard set and
// near-universally supported, but this provider's acceptance of each one is an
// assumption until a UAT booking proves it. The mitigation is the default:
// NO_MEAL_PREFERENCE sends '', which is what every booking has always sent and
// is therefore known to work — so an unrecognised code costs a traveller their
// special meal, never a rejected booking.
//
// THREE CODES PEOPLE CONFUSE, worth being exact about because getting them
// wrong hands someone food they do not eat:
//   VGML  Vegetarian VEGAN — no dairy, no egg
//   VLML  Vegetarian lacto-ovo — dairy and egg allowed
//   AVML  Asian vegetarian — Indian-style and spiced, the common Indian choice
// ─────────────────────────────────────────────────────────────────────────────

export const NO_MEAL_PREFERENCE = ''

export interface MealCode {
  code: string
  label: string
  // Shown under the label. Says what the meal EXCLUDES where that is the thing
  // people get wrong, rather than restating the name.
  note?: string
  // Restricts the option to a passenger type. A baby meal offered for an adult
  // is noise in a list someone has to read.
  paxType?: 'ADT' | 'CHD' | 'INF'
}

export const MEAL_CODES: MealCode[] = [
  // Dietary and religious — the ones most often needed.
  { code: 'AVML', label: 'Asian vegetarian', note: 'Indian-style, spiced' },
  { code: 'VLML', label: 'Vegetarian', note: 'Allows dairy and egg' },
  { code: 'VGML', label: 'Vegan', note: 'No dairy or egg' },
  { code: 'VJML', label: 'Jain vegetarian', note: 'No root vegetables' },
  { code: 'HNML', label: 'Hindu non-vegetarian' },
  { code: 'MOML', label: 'Muslim / halal' },
  { code: 'KSML', label: 'Kosher', note: 'Usually needs 24–48 hours notice' },
  { code: 'SFML', label: 'Seafood' },

  // Medical and dietary restriction.
  { code: 'GFML', label: 'Gluten intolerant' },
  { code: 'DBML', label: 'Diabetic' },
  { code: 'NLML', label: 'Non-lactose' },
  { code: 'LSML', label: 'Low salt' },
  { code: 'LFML', label: 'Low fat' },
  { code: 'LCML', label: 'Low calorie' },
  { code: 'BLML', label: 'Bland' },

  // Other standard trays.
  { code: 'FPML', label: 'Fruit platter' },
  { code: 'RVML', label: 'Raw vegetarian' },

  // Age-specific.
  { code: 'CHML', label: 'Child meal', paxType: 'CHD' },
  { code: 'BBML', label: 'Baby meal', paxType: 'INF' },
]

// Which codes to offer a given passenger. An adult never sees a baby meal; an
// infant sees only the baby meal plus no-preference.
export function mealCodesFor(paxType: string): MealCode[] {
  return MEAL_CODES.filter(m => !m.paxType || m.paxType === paxType)
}

export function mealLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return MEAL_CODES.find(m => m.code === code)?.label ?? code
}

// ── fromProfilePreference ────────────────────────────────────────────────────
// /profile stores a coarser vocabulary of its own — 'Non-Veg' | 'Veg' | 'Vegan'
// | 'Eggetarian' — which predates this module and is not a set of meal codes.
// It is the PREFILL; the per-passenger selector is the finer control.
//
// 'Non-Veg' maps to no preference rather than to a code, because "I eat
// everything" is a request for the standard tray, not for a special meal.
export function fromProfilePreference(preference: string | null | undefined): string {
  switch (preference) {
    case 'Veg': return 'AVML'
    case 'Vegan': return 'VGML'
    case 'Eggetarian': return 'VLML'
    default: return NO_MEAL_PREFERENCE
  }
}
