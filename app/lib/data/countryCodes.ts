// ISO 3166-1 alpha-2 code -> country name. Small, static set covering the
// countries this platform's passenger form realistically needs (matches
// COMMON_COUNTRIES in locations.ts). Extend as traveler nationalities require.
export const COUNTRY_CODE_TO_NAME: Record<string, string> = {
  IN: 'India',
  US: 'United States',
  GB: 'United Kingdom',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  SG: 'Singapore',
  AU: 'Australia',
  CA: 'Canada',
  DE: 'Germany',
  FR: 'France',
  NL: 'Netherlands',
  CH: 'Switzerland',
  JP: 'Japan',
  KR: 'South Korea',
  TH: 'Thailand',
  MY: 'Malaysia',
  HK: 'Hong Kong',
  QA: 'Qatar',
  KW: 'Kuwait',
  BH: 'Bahrain',
  OM: 'Oman',
}

// Amadeus requires a non-empty CountryName. Falls back to the raw code if
// unmapped, rather than an empty string, since an unrecognized code shown
// back to the user is more debuggable than a silent validation failure.
export function countryNameFromCode(code: string): string {
  return COUNTRY_CODE_TO_NAME[code.toUpperCase()] ?? code
}