// ── India-focused location data ──────────────────────────────────────────────
// Single source of truth for every city/country dropdown in the app.
// Scoped to India for now, per current market focus — extend when the
// product actually expands beyond India rather than pre-building a full
// worldwide list nobody uses yet.

export interface StateWithCities {
  state: string
  cities: string[]
}

export const INDIAN_STATES_AND_CITIES: StateWithCities[] = [
  { state: 'Andhra Pradesh', cities: ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Tirupati'] },
  { state: 'Delhi', cities: ['New Delhi'] },
  { state: 'Gujarat', cities: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot'] },
  { state: 'Haryana', cities: ['Gurugram', 'Faridabad', 'Panipat'] },
  { state: 'Karnataka', cities: ['Bengaluru', 'Mysuru', 'Mangaluru', 'Hubballi'] },
  { state: 'Kerala', cities: ['Kochi', 'Thiruvananthapuram', 'Kozhikode'] },
  { state: 'Maharashtra', cities: ['Mumbai', 'Pune', 'Nagpur', 'Nashik'] },
  { state: 'Punjab', cities: ['Chandigarh', 'Ludhiana', 'Amritsar'] },
  { state: 'Rajasthan', cities: ['Jaipur', 'Udaipur', 'Jodhpur'] },
  { state: 'Tamil Nadu', cities: ['Chennai', 'Coimbatore', 'Madurai'] },
  { state: 'Telangana', cities: ['Hyderabad', 'Warangal'] },
  { state: 'Uttar Pradesh', cities: ['Lucknow', 'Noida', 'Kanpur', 'Varanasi'] },
  { state: 'West Bengal', cities: ['Kolkata', 'Howrah', 'Siliguri'] },
]

// Flat list, for a simple single-level city dropdown when state isn't needed separately
export const ALL_INDIAN_CITIES: string[] = INDIAN_STATES_AND_CITIES
  .flatMap(s => s.cities)
  .sort()

export const COMMON_COUNTRIES: string[] = [
  'India',
  'United Arab Emirates',
  'Singapore',
  'United Kingdom',
  'United States',
]

export function isValidIndianCity(city: string): boolean {
  return ALL_INDIAN_CITIES.includes(city)
}

export function isValidCountry(country: string): boolean {
  return COMMON_COUNTRIES.includes(country)
}