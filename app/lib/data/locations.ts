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

export interface Airport {
  code: string
  name: string
  city: string
  country: string
}

export const AIRPORTS: Airport[] = [
  // ── India ──────────────────────────────────────────────────────────────────
  { code: 'DEL', name: 'Indira Gandhi International', city: 'New Delhi',       country: 'India' },
  { code: 'BOM', name: 'Chhatrapati Shivaji Maharaj', city: 'Mumbai',          country: 'India' },
  { code: 'BLR', name: 'Kempegowda International',    city: 'Bengaluru',       country: 'India' },
  { code: 'MAA', name: 'Chennai International',        city: 'Chennai',         country: 'India' },
  { code: 'CCU', name: 'Netaji Subhas Chandra Bose',  city: 'Kolkata',         country: 'India' },
  { code: 'HYD', name: 'Rajiv Gandhi International',  city: 'Hyderabad',       country: 'India' },
  { code: 'AMD', name: 'Sardar Vallabhbhai Patel',    city: 'Ahmedabad',       country: 'India' },
  { code: 'COK', name: 'Cochin International',         city: 'Kochi',           country: 'India' },
  { code: 'TRV', name: 'Trivandrum International',    city: 'Thiruvananthapuram', country: 'India' },
  { code: 'GOI', name: 'Goa International (Dabolim)', city: 'Goa',             country: 'India' },
  { code: 'GAU', name: 'Lokpriya Gopinath Bordoloi',  city: 'Guwahati',        country: 'India' },
  { code: 'PNQ', name: 'Pune Airport',                city: 'Pune',            country: 'India' },
  { code: 'JAI', name: 'Jaipur International',        city: 'Jaipur',          country: 'India' },
  { code: 'ATQ', name: 'Sri Guru Ram Dass Jee Intl',  city: 'Amritsar',        country: 'India' },
  { code: 'IXC', name: 'Chandigarh Airport',          city: 'Chandigarh',      country: 'India' },
  { code: 'LKO', name: 'Chaudhary Charan Singh Intl', city: 'Lucknow',         country: 'India' },
  { code: 'PAT', name: 'Jay Prakash Narayan Intl',    city: 'Patna',           country: 'India' },
  { code: 'IXR', name: 'Birsa Munda Airport',         city: 'Ranchi',          country: 'India' },
  { code: 'VNS', name: 'Lal Bahadur Shastri Intl',   city: 'Varanasi',        country: 'India' },
  { code: 'IDR', name: 'Devi Ahilya Bai Holkar',      city: 'Indore',          country: 'India' },
  { code: 'NAG', name: 'Dr. Babasaheb Ambedkar Intl', city: 'Nagpur',          country: 'India' },
  { code: 'BBI', name: 'Biju Patnaik International',  city: 'Bhubaneswar',     country: 'India' },
  { code: 'IXB', name: 'Bagdogra Airport',            city: 'Siliguri',        country: 'India' },
  { code: 'SXR', name: 'Sheikh ul-Alam International',city: 'Srinagar',        country: 'India' },
  { code: 'IXJ', name: 'Jammu Airport',               city: 'Jammu',           country: 'India' },
  { code: 'UDR', name: 'Maharana Pratap Airport',     city: 'Udaipur',         country: 'India' },
  { code: 'BHO', name: 'Raja Bhoj Airport',           city: 'Bhopal',          country: 'India' },
  { code: 'RPR', name: 'Swami Vivekananda Airport',   city: 'Raipur',          country: 'India' },
  { code: 'IXA', name: 'Agartala Airport',            city: 'Agartala',        country: 'India' },
  { code: 'STV', name: 'Surat Airport',               city: 'Surat',           country: 'India' },

  // ── Middle East ────────────────────────────────────────────────────────────
  { code: 'DXB', name: 'Dubai International',         city: 'Dubai',           country: 'UAE' },
  { code: 'AUH', name: 'Abu Dhabi International',     city: 'Abu Dhabi',       country: 'UAE' },
  { code: 'SHJ', name: 'Sharjah International',       city: 'Sharjah',         country: 'UAE' },
  { code: 'DOH', name: 'Hamad International',         city: 'Doha',            country: 'Qatar' },
  { code: 'KWI', name: 'Kuwait International',        city: 'Kuwait City',     country: 'Kuwait' },
  { code: 'BAH', name: 'Bahrain International',       city: 'Manama',          country: 'Bahrain' },
  { code: 'MCT', name: 'Muscat International',        city: 'Muscat',          country: 'Oman' },
  { code: 'RUH', name: 'King Khalid International',  city: 'Riyadh',          country: 'Saudi Arabia' },
  { code: 'JED', name: 'King Abdulaziz International',city: 'Jeddah',          country: 'Saudi Arabia' },

  // ── Southeast & East Asia ─────────────────────────────────────────────────
  { code: 'SIN', name: 'Singapore Changi',            city: 'Singapore',       country: 'Singapore' },
  { code: 'BKK', name: 'Suvarnabhumi Airport',        city: 'Bangkok',         country: 'Thailand' },
  { code: 'KUL', name: 'Kuala Lumpur International',  city: 'Kuala Lumpur',    country: 'Malaysia' },
  { code: 'HKG', name: 'Hong Kong International',     city: 'Hong Kong',       country: 'Hong Kong' },
  { code: 'NRT', name: 'Narita International',        city: 'Tokyo',           country: 'Japan' },
  { code: 'ICN', name: 'Incheon International',       city: 'Seoul',           country: 'South Korea' },

  // ── Europe ────────────────────────────────────────────────────────────────
  { code: 'LHR', name: 'Heathrow Airport',            city: 'London',          country: 'United Kingdom' },
  { code: 'CDG', name: 'Charles de Gaulle',           city: 'Paris',           country: 'France' },
  { code: 'FRA', name: 'Frankfurt Airport',           city: 'Frankfurt',       country: 'Germany' },
  { code: 'AMS', name: 'Amsterdam Schiphol',          city: 'Amsterdam',       country: 'Netherlands' },
  { code: 'ZUR', name: 'Zurich Airport',              city: 'Zurich',          country: 'Switzerland' },

  // ── North America ─────────────────────────────────────────────────────────
  { code: 'JFK', name: 'John F. Kennedy International', city: 'New York',      country: 'United States' },
  { code: 'EWR', name: 'Newark Liberty International',  city: 'New York',      country: 'United States' },
  { code: 'ORD', name: "O'Hare International",          city: 'Chicago',       country: 'United States' },
  { code: 'SFO', name: 'San Francisco International',   city: 'San Francisco', country: 'United States' },
  { code: 'LAX', name: 'Los Angeles International',     city: 'Los Angeles',   country: 'United States' },
  { code: 'YYZ', name: 'Toronto Pearson International', city: 'Toronto',       country: 'Canada' },
]

// Fast lookup by code — used by classifyTrip and display formatting
export const AIRPORT_BY_CODE: Record<string, Airport> = Object.fromEntries(
  AIRPORTS.map(a => [a.code, a])
)

// Grouped by country — useful for optgroup rendering in dropdowns
export const AIRPORTS_BY_COUNTRY: Record<string, Airport[]> = AIRPORTS.reduce(
  (acc, airport) => {
    if (!acc[airport.country]) acc[airport.country] = []
    acc[airport.country].push(airport)
    return acc
  },
  {} as Record<string, Airport[]>
)