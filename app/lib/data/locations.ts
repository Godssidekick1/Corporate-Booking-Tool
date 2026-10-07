// ── GST state codes ──────────────────────────────────────────────────────────
// India's 28 states and 8 union territories by the GST state code -- the first
// two digits of every GSTIN registered there. The names are exactly GeoNames'
// names for India's regions (the state pickers' list), so a picked state looks
// up directly. Place lists themselves come from GeoNames (app/lib/repositories/
// reference.ts); this file keeps only what GeoNames does not carry.
// ─────────────────────────────────────────────────────────────────────────────

const GST_STATE_CODES: Record<string, string> = {
  'Andaman and Nicobar Islands':              '35',
  'Andhra Pradesh':                           '37',
  'Arunachal Pradesh':                        '12',
  'Assam':                                    '18',
  'Bihar':                                    '10',
  'Chandigarh':                               '04',
  'Chhattisgarh':                             '22',
  'Dadra and Nagar Haveli and Daman and Diu': '26',
  'Delhi':                                    '07',
  'Goa':                                      '30',
  'Gujarat':                                  '24',
  'Haryana':                                  '06',
  'Himachal Pradesh':                         '02',
  'Jammu and Kashmir':                        '01',
  'Jharkhand':                                '20',
  'Karnataka':                                '29',
  'Kerala':                                   '32',
  'Ladakh':                                   '38',
  'Lakshadweep':                              '31',
  'Madhya Pradesh':                           '23',
  'Maharashtra':                              '27',
  'Manipur':                                  '14',
  'Meghalaya':                                '17',
  'Mizoram':                                  '15',
  'Nagaland':                                 '13',
  'Odisha':                                   '21',
  'Puducherry':                               '34',
  'Punjab':                                   '03',
  'Rajasthan':                                '08',
  'Sikkim':                                   '11',
  'Tamil Nadu':                               '33',
  'Telangana':                                '36',
  'Tripura':                                  '16',
  'Uttar Pradesh':                            '09',
  'Uttarakhand':                              '05',
  'West Bengal':                              '19',
}

const STATE_BY_GST_CODE = new Map(Object.entries(GST_STATE_CODES).map(([state, code]) => [code, state]))

export function stateForGstCode(code: string): string | null {
  return STATE_BY_GST_CODE.get(code) ?? null
}

export function gstCodeForState(state: string): string | null {
  return GST_STATE_CODES[state] ?? null
}
