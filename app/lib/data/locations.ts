// ── India-focused location data ──────────────────────────────────────────────
// Single source of truth for every city/country dropdown in the app.
// Scoped to India for now, per current market focus — extend when the
// product actually expands beyond India rather than pre-building a full
// worldwide list nobody uses yet.

export interface StateWithCities {
  state: string
  // The GST state code — the first two digits of every GSTIN registered there.
  // Kept beside the name because there is nowhere else sensible for the map to
  // live, and the branch master needs it to tell a GSTIN and a state apart when
  // they disagree.
  gstCode: string
  cities: string[]
}

// All 28 states and 8 union territories. Previously 13, which was merely
// limiting for a client's address and an outright blocker for a branch: GST
// registers per state, so a TMC in Assam or Odisha could not record its own
// office at all.
//
// Cities are SUGGESTIONS, not a whitelist. A branch can sit in a town this list
// has never heard of, so every city input accepts free text.
export const INDIAN_STATES_AND_CITIES: StateWithCities[] = [
  { state: 'Andaman and Nicobar Islands', gstCode: '35', cities: ['Port Blair'] },
  { state: 'Andhra Pradesh',              gstCode: '37', cities: ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Tirupati', 'Nellore'] },
  { state: 'Arunachal Pradesh',           gstCode: '12', cities: ['Itanagar', 'Naharlagun'] },
  { state: 'Assam',                       gstCode: '18', cities: ['Guwahati', 'Silchar', 'Dibrugarh', 'Jorhat'] },
  { state: 'Bihar',                       gstCode: '10', cities: ['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur'] },
  { state: 'Chandigarh',                  gstCode: '04', cities: ['Chandigarh'] },
  { state: 'Chhattisgarh',                gstCode: '22', cities: ['Raipur', 'Bhilai', 'Bilaspur'] },
  { state: 'Dadra and Nagar Haveli and Daman and Diu', gstCode: '26', cities: ['Daman', 'Silvassa', 'Diu'] },
  { state: 'Delhi',                       gstCode: '07', cities: ['New Delhi', 'Delhi'] },
  { state: 'Goa',                         gstCode: '30', cities: ['Panaji', 'Margao', 'Vasco da Gama'] },
  { state: 'Gujarat',                     gstCode: '24', cities: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Gandhinagar'] },
  { state: 'Haryana',                     gstCode: '06', cities: ['Gurugram', 'Faridabad', 'Panipat', 'Karnal'] },
  { state: 'Himachal Pradesh',            gstCode: '02', cities: ['Shimla', 'Dharamshala', 'Manali'] },
  { state: 'Jammu and Kashmir',           gstCode: '01', cities: ['Srinagar', 'Jammu'] },
  { state: 'Jharkhand',                   gstCode: '20', cities: ['Ranchi', 'Jamshedpur', 'Dhanbad'] },
  { state: 'Karnataka',                   gstCode: '29', cities: ['Bengaluru', 'Mysuru', 'Mangaluru', 'Hubballi', 'Belagavi'] },
  { state: 'Kerala',                      gstCode: '32', cities: ['Kochi', 'Thiruvananthapuram', 'Kozhikode', 'Thrissur'] },
  { state: 'Ladakh',                      gstCode: '38', cities: ['Leh', 'Kargil'] },
  { state: 'Lakshadweep',                 gstCode: '31', cities: ['Kavaratti'] },
  { state: 'Madhya Pradesh',              gstCode: '23', cities: ['Bhopal', 'Indore', 'Gwalior', 'Jabalpur'] },
  { state: 'Maharashtra',                 gstCode: '27', cities: ['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Aurangabad'] },
  { state: 'Manipur',                     gstCode: '14', cities: ['Imphal'] },
  { state: 'Meghalaya',                   gstCode: '17', cities: ['Shillong'] },
  { state: 'Mizoram',                     gstCode: '15', cities: ['Aizawl'] },
  { state: 'Nagaland',                    gstCode: '13', cities: ['Kohima', 'Dimapur'] },
  { state: 'Odisha',                      gstCode: '21', cities: ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Puri'] },
  { state: 'Puducherry',                  gstCode: '34', cities: ['Puducherry', 'Karaikal'] },
  { state: 'Punjab',                      gstCode: '03', cities: ['Ludhiana', 'Amritsar', 'Jalandhar', 'Mohali'] },
  { state: 'Rajasthan',                   gstCode: '08', cities: ['Jaipur', 'Udaipur', 'Jodhpur', 'Kota'] },
  { state: 'Sikkim',                      gstCode: '11', cities: ['Gangtok'] },
  { state: 'Tamil Nadu',                  gstCode: '33', cities: ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem'] },
  { state: 'Telangana',                   gstCode: '36', cities: ['Hyderabad', 'Warangal', 'Nizamabad'] },
  { state: 'Tripura',                     gstCode: '16', cities: ['Agartala'] },
  { state: 'Uttar Pradesh',               gstCode: '09', cities: ['Lucknow', 'Noida', 'Kanpur', 'Varanasi', 'Agra', 'Ghaziabad'] },
  { state: 'Uttarakhand',                 gstCode: '05', cities: ['Dehradun', 'Haridwar', 'Rishikesh'] },
  { state: 'West Bengal',                 gstCode: '19', cities: ['Kolkata', 'Howrah', 'Siliguri', 'Durgapur'] },
]

export const INDIAN_STATES: string[] = INDIAN_STATES_AND_CITIES.map(s => s.state)

const STATE_BY_GST_CODE = new Map(INDIAN_STATES_AND_CITIES.map(s => [s.gstCode, s.state]))
const GST_CODE_BY_STATE = new Map(INDIAN_STATES_AND_CITIES.map(s => [s.state, s.gstCode]))

// Cities for one state, for narrowing the suggestion list once a state is
// chosen. Unknown state -> every city, so the field still helps rather than
// going empty.
export function citiesForState(state: string): string[] {
  return INDIAN_STATES_AND_CITIES.find(s => s.state === state)?.cities ?? ALL_INDIAN_CITIES
}

export function stateForGstCode(code: string): string | null {
  return STATE_BY_GST_CODE.get(code) ?? null
}

export function gstCodeForState(state: string): string | null {
  return GST_CODE_BY_STATE.get(state) ?? null
}

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

  // ── India, the rest of the scheduled network ───────────────────────────────
  // The list above was the 30 largest airports, which is fine for a demo and
  // wrong for a corporate travel tool: a company with a plant in Hosur flies
  // people into Coimbatore, and a team in Assam flies to Dibrugarh. If the
  // airport is not here it cannot be typed, because the search route requires a
  // three-letter code and this is where they come from.
  //
  // Still a curated list, not the full register — see the note under AIRPORTS
  // about where a complete one would have to come from.
  { code: 'CJB', name: 'Coimbatore International',    city: 'Coimbatore',      country: 'India' },
  { code: 'IXM', name: 'Madurai International',       city: 'Madurai',         country: 'India' },
  { code: 'TRZ', name: 'Tiruchirappalli International', city: 'Tiruchirappalli', country: 'India' },
  { code: 'SXV', name: 'Salem Airport',               city: 'Salem',           country: 'India' },
  { code: 'TCR', name: 'Thoothukudi Airport',         city: 'Thoothukudi',     country: 'India' },
  { code: 'PNY', name: 'Puducherry Airport',          city: 'Puducherry',      country: 'India' },
  { code: 'IXE', name: 'Mangaluru International',     city: 'Mangaluru',       country: 'India' },
  { code: 'CCJ', name: 'Calicut International',       city: 'Kozhikode',       country: 'India' },
  { code: 'CNN', name: 'Kannur International',        city: 'Kannur',          country: 'India' },
  { code: 'MYQ', name: 'Mysuru Airport',              city: 'Mysuru',          country: 'India' },
  { code: 'HBX', name: 'Hubballi Airport',            city: 'Hubballi',        country: 'India' },
  { code: 'IXG', name: 'Belagavi Airport',            city: 'Belagavi',        country: 'India' },
  { code: 'VTZ', name: 'Visakhapatnam International', city: 'Visakhapatnam',   country: 'India' },
  { code: 'VGA', name: 'Vijayawada International',    city: 'Vijayawada',      country: 'India' },
  { code: 'TIR', name: 'Tirupati Airport',            city: 'Tirupati',        country: 'India' },
  { code: 'RJA', name: 'Rajahmundry Airport',         city: 'Rajahmundry',     country: 'India' },
  { code: 'IXU', name: 'Aurangabad Airport',          city: 'Aurangabad',      country: 'India' },
  { code: 'ISK', name: 'Nashik Airport',              city: 'Nashik',          country: 'India' },
  { code: 'BDQ', name: 'Vadodara Airport',            city: 'Vadodara',        country: 'India' },
  { code: 'RAJ', name: 'Rajkot Airport',              city: 'Rajkot',          country: 'India' },
  { code: 'JGA', name: 'Jamnagar Airport',            city: 'Jamnagar',        country: 'India' },
  { code: 'BHU', name: 'Bhavnagar Airport',           city: 'Bhavnagar',       country: 'India' },
  { code: 'BHJ', name: 'Bhuj Airport',                city: 'Bhuj',            country: 'India' },
  { code: 'PBD', name: 'Porbandar Airport',           city: 'Porbandar',       country: 'India' },
  { code: 'JDH', name: 'Jodhpur Airport',             city: 'Jodhpur',         country: 'India' },
  { code: 'JSA', name: 'Jaisalmer Airport',           city: 'Jaisalmer',       country: 'India' },
  { code: 'AGR', name: 'Agra Airport',                city: 'Agra',            country: 'India' },
  { code: 'KNU', name: 'Kanpur Airport',              city: 'Kanpur',          country: 'India' },
  { code: 'GOP', name: 'Gorakhpur Airport',           city: 'Gorakhpur',       country: 'India' },
  { code: 'IXD', name: 'Prayagraj Airport',           city: 'Prayagraj',       country: 'India' },
  { code: 'DED', name: 'Dehradun Airport',            city: 'Dehradun',        country: 'India' },
  { code: 'KUU', name: 'Kullu Manali Airport',        city: 'Kullu',           country: 'India' },
  { code: 'DHM', name: 'Kangra Airport',              city: 'Dharamshala',     country: 'India' },
  { code: 'LUH', name: 'Ludhiana Airport',            city: 'Ludhiana',        country: 'India' },
  { code: 'GWL', name: 'Gwalior Airport',             city: 'Gwalior',         country: 'India' },
  { code: 'JLR', name: 'Jabalpur Airport',            city: 'Jabalpur',        country: 'India' },
  { code: 'HJR', name: 'Khajuraho Airport',           city: 'Khajuraho',       country: 'India' },
  { code: 'GAY', name: 'Gaya International',          city: 'Gaya',            country: 'India' },
  { code: 'DBR', name: 'Darbhanga Airport',           city: 'Darbhanga',       country: 'India' },
  { code: 'IXW', name: 'Sonari Airport',              city: 'Jamshedpur',      country: 'India' },
  { code: 'RRK', name: 'Rourkela Airport',            city: 'Rourkela',        country: 'India' },
  { code: 'JRG', name: 'Jharsuguda Airport',          city: 'Jharsuguda',      country: 'India' },
  { code: 'IXZ', name: 'Veer Savarkar International', city: 'Port Blair',      country: 'India' },
  { code: 'AGX', name: 'Agatti Airport',              city: 'Agatti',          country: 'India' },
  { code: 'IXL', name: 'Kushok Bakula Rimpochee',     city: 'Leh',             country: 'India' },
  { code: 'IXS', name: 'Silchar Airport',             city: 'Silchar',         country: 'India' },
  { code: 'DIB', name: 'Dibrugarh Airport',           city: 'Dibrugarh',       country: 'India' },
  { code: 'JRH', name: 'Jorhat Airport',              city: 'Jorhat',          country: 'India' },
  { code: 'IMF', name: 'Imphal International',        city: 'Imphal',          country: 'India' },
  { code: 'SHL', name: 'Shillong Airport',            city: 'Shillong',        country: 'India' },
  { code: 'AJL', name: 'Lengpui Airport',             city: 'Aizawl',          country: 'India' },
  { code: 'DMU', name: 'Dimapur Airport',             city: 'Dimapur',         country: 'India' },

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
  { code: 'YVR', name: 'Vancouver International',     city: 'Vancouver',       country: 'Canada' },
  { code: 'BOS', name: 'Boston Logan International',  city: 'Boston',          country: 'USA' },
  { code: 'IAD', name: 'Washington Dulles International', city: 'Washington',  country: 'USA' },
  { code: 'ATL', name: 'Hartsfield-Jackson Atlanta',  city: 'Atlanta',         country: 'USA' },
  { code: 'DFW', name: 'Dallas/Fort Worth International', city: 'Dallas',      country: 'USA' },
  { code: 'SEA', name: 'Seattle-Tacoma International', city: 'Seattle',        country: 'USA' },
  { code: 'MIA', name: 'Miami International',         city: 'Miami',           country: 'USA' },

  // ── South Asia and the Indian Ocean ────────────────────────────────────────
  { code: 'CMB', name: 'Bandaranaike International',  city: 'Colombo',         country: 'Sri Lanka' },
  { code: 'KTM', name: 'Tribhuvan International',     city: 'Kathmandu',       country: 'Nepal' },
  { code: 'DAC', name: 'Hazrat Shahjalal International', city: 'Dhaka',        country: 'Bangladesh' },
  { code: 'MLE', name: 'Velana International',        city: 'Malé',            country: 'Maldives' },

  // ── Rest of Asia-Pacific ───────────────────────────────────────────────────
  { code: 'DMK', name: 'Don Mueang International',    city: 'Bangkok',         country: 'Thailand' },
  { code: 'HAN', name: 'Noi Bai International',       city: 'Hanoi',           country: 'Vietnam' },
  { code: 'SGN', name: 'Tan Son Nhat International',  city: 'Ho Chi Minh City', country: 'Vietnam' },
  { code: 'CGK', name: 'Soekarno-Hatta International', city: 'Jakarta',        country: 'Indonesia' },
  { code: 'MNL', name: 'Ninoy Aquino International',  city: 'Manila',          country: 'Philippines' },
  { code: 'PVG', name: 'Shanghai Pudong International', city: 'Shanghai',      country: 'China' },
  { code: 'PEK', name: 'Beijing Capital International', city: 'Beijing',       country: 'China' },
  { code: 'CAN', name: 'Guangzhou Baiyun International', city: 'Guangzhou',    country: 'China' },
  { code: 'TPE', name: 'Taiwan Taoyuan International', city: 'Taipei',         country: 'Taiwan' },
  { code: 'SYD', name: 'Sydney Kingsford Smith',      city: 'Sydney',          country: 'Australia' },
  { code: 'MEL', name: 'Melbourne Airport',           city: 'Melbourne',       country: 'Australia' },
  { code: 'PER', name: 'Perth Airport',               city: 'Perth',           country: 'Australia' },
  { code: 'AKL', name: 'Auckland Airport',            city: 'Auckland',        country: 'New Zealand' },

  // ── Rest of Europe ─────────────────────────────────────────────────────────
  { code: 'LGW', name: 'London Gatwick',              city: 'London',          country: 'United Kingdom' },
  { code: 'MAN', name: 'Manchester Airport',          city: 'Manchester',      country: 'United Kingdom' },
  { code: 'DUB', name: 'Dublin Airport',              city: 'Dublin',          country: 'Ireland' },
  { code: 'MUC', name: 'Munich Airport',              city: 'Munich',          country: 'Germany' },
  { code: 'VIE', name: 'Vienna International',        city: 'Vienna',          country: 'Austria' },
  { code: 'BRU', name: 'Brussels Airport',            city: 'Brussels',        country: 'Belgium' },
  { code: 'MAD', name: 'Adolfo Suárez Madrid-Barajas', city: 'Madrid',         country: 'Spain' },
  { code: 'FCO', name: 'Leonardo da Vinci-Fiumicino', city: 'Rome',            country: 'Italy' },
  { code: 'MXP', name: 'Milan Malpensa',              city: 'Milan',           country: 'Italy' },
  { code: 'CPH', name: 'Copenhagen Airport',          city: 'Copenhagen',      country: 'Denmark' },
  { code: 'ARN', name: 'Stockholm Arlanda',           city: 'Stockholm',       country: 'Sweden' },
  { code: 'HEL', name: 'Helsinki-Vantaa',             city: 'Helsinki',        country: 'Finland' },
  { code: 'IST', name: 'Istanbul Airport',            city: 'Istanbul',        country: 'Turkey' },

  // ── Middle East and Africa ─────────────────────────────────────────────────
  { code: 'DMM', name: 'King Fahd International',     city: 'Dammam',          country: 'Saudi Arabia' },
  { code: 'AMM', name: 'Queen Alia International',    city: 'Amman',           country: 'Jordan' },
  { code: 'TLV', name: 'Ben Gurion Airport',          city: 'Tel Aviv',        country: 'Israel' },
  { code: 'CAI', name: 'Cairo International',         city: 'Cairo',           country: 'Egypt' },
  { code: 'ADD', name: 'Bole International',          city: 'Addis Ababa',     country: 'Ethiopia' },
  { code: 'NBO', name: 'Jomo Kenyatta International', city: 'Nairobi',         country: 'Kenya' },
  { code: 'JNB', name: 'O. R. Tambo International',   city: 'Johannesburg',    country: 'South Africa' },
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