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
  // Among the few most asked for, listed first. The rest sit under "More
  // options": standard IATA codes, but not every flight loads every one.
  common?: true
}

export const MEAL_CODES: MealCode[] = [
  // Dietary and religious — the ones most often needed.
  { code: 'AVML', label: 'Asian vegetarian', note: 'Indian-style, spiced', common: true },
  { code: 'VLML', label: 'Vegetarian', note: 'Allows dairy and egg', common: true },
  { code: 'VGML', label: 'Vegan', note: 'No dairy or egg', common: true },
  { code: 'VJML', label: 'Jain vegetarian', note: 'No root vegetables', common: true },
  { code: 'HNML', label: 'Hindu non-vegetarian' },
  { code: 'MOML', label: 'Muslim / halal', common: true },
  { code: 'KSML', label: 'Kosher', note: 'Usually needs 24–48 hours notice' },
  { code: 'SFML', label: 'Seafood' },

  // Medical and dietary restriction.
  { code: 'GFML', label: 'Gluten intolerant' },
  { code: 'DBML', label: 'Diabetic', common: true },
  { code: 'NLML', label: 'Non-lactose' },
  { code: 'LSML', label: 'Low salt' },
  { code: 'LFML', label: 'Low fat' },
  { code: 'LCML', label: 'Low calorie' },
  { code: 'BLML', label: 'Bland' },

  // Other standard trays.
  { code: 'FPML', label: 'Fruit platter' },
  { code: 'RVML', label: 'Raw vegetarian' },

  // Age-specific.
  { code: 'CHML', label: 'Child meal', paxType: 'CHD', common: true },
  { code: 'BBML', label: 'Baby meal', paxType: 'INF', common: true },
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

// ── What to offer, and when ──────────────────────────────────────────────────
// Not every flight carries all nineteen codes, and the provider has no way to
// ask which ones a given flight takes (a question for them: see
// docs/provider-questions.md). So the list leads with the few most asked for,
// and says plainly when a meal cannot be pre-ordered at all.

export function mealGroupsFor(paxType: string): { common: MealCode[]; more: MealCode[] } {
  const all = mealCodesFor(paxType)
  return { common: all.filter(m => m.common), more: all.filter(m => !m.common) }
}

// Whether a special meal can be asked for on this flight at all. A low-cost
// carrier sells meals (a paid add-on, which we do not sell), and a fare
// without a meal has none to swap. Either way MealCode goes as ''.
export function mealsOrderable(isLcc: boolean | undefined, mealIncluded: boolean | undefined): boolean {
  return !isLcc && mealIncluded !== false
}

export interface MealGuidance {
  orderable: boolean
  text: string
  // Only when it matters: less than a day before departure.
  warning: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

export function mealGuidance(o: {
  isLcc?: boolean
  mealIncluded?: boolean
  departure?: string | null   // the first departure, as the itinerary has it
  now?: Date
}): MealGuidance {
  if (o.isLcc) {
    return { orderable: false, warning: null,
      text: 'Meals on this airline are sold on board or as a paid add-on, so they can’t be pre-ordered here.' }
  }
  if (o.mealIncluded === false) {
    return { orderable: false, warning: null,
      text: 'This fare does not include a meal, so a preference cannot be requested. Meals may be available to buy on board.' }
  }
  const leaves = o.departure ? new Date(o.departure).getTime() : NaN
  const toGo = leaves - (o.now ?? new Date()).getTime()
  return {
    orderable: true,
    text: 'This fare includes a meal. The most asked-for special meals are listed first; the others are standard airline codes that not every flight carries.',
    warning: toGo > 0 && toGo < DAY_MS
      ? 'This flight leaves in less than a day. Airlines usually need 24–48 hours’ notice for a special meal, so it may not be loaded.'
      : null,
  }
}
