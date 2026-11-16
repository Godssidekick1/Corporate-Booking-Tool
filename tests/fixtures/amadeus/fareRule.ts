// ── Fare rule responses from the provider's test system ──────────────────────
// Captured 2026-11-16 by a probe (one Air India DEL-BOM search, then
// flight/Non-LccFareRule; nothing priced, held or booked). Session and pricing
// keys were never kept. Shown as amadeus.fareRule returns them: top-level keys
// normalised to PascalCase; Remarks is the provider's JSON *string*, untouched.
// ─────────────────────────────────────────────────────────────────────────────

// An Air India ECOVALU fare: cancel INR 5,000 / change INR 3,500 up to 2 hours
// before departure, no-show forfeited, free within 48 hours of booking.
export const FARE_RULE_AI_ECOVALU = {
  Status: 'Success',
  Error: null,
  FareRulesFlight: [{ Remarks: "[{\"fareKey\":\"DELBOM-AI2943-20261207-T-TU1YXSII_D-O-100\",\"validatingCarrier\":\"AI\",\"fareBasis\":[\"TU1YXSII\"],\"dealCode\":\"\",\"traveldate\":\"2026-12-07 07:30\",\"origin\":\"DEL\",\"destination\":\"BOM\",\"policy\":[{\"paxType\":\"ADT\",\"fareBasis\":\"TU1YXSII\",\"policies\":[{\"policyType\":33,\"timeline\":[{\"condition\":1,\"charge\":[{\"from\":2,\"to\":451,\"value\":5000,\"currency\":\"INR\",\"permitted\":\"T\"}],\"Remark\":\"charge inr 5000 for cancel/refund. note till 02 hrs charge inr 5000 per component for cancellation\"},{\"condition\":3,\"charge\":[{\"from\":0,\"to\":2,\"value\":0,\"currency\":\"INR\",\"permitted\":\"F\"}],\"Remark\":\"ticket is non-refundable in case of no-show. note 100 percent of basic fare plus YQ will be forfeited. only tax refundable\"},{\"condition\":4,\"charge\":[{\"from\":451,\"to\":499,\"value\":0,\"currency\":\"INR\",\"permitted\":\"T\"}],\"Remark\":\"reservations booked more than 7 days prior to commencement of travel may be cancelled or amended within 48 hours of booking ticket without penalty.\"}]},{\"policyType\":31,\"timeline\":[{\"condition\":1,\"charge\":[{\"from\":2,\"to\":451,\"value\":3500,\"currency\":\"INR\",\"permitted\":\"T\"}],\"Remark\":\"charge inr 3500 for reissue/revalidation. note till 02 hrs charge inr 3500 per component for reissue/revalidation\"},{\"condition\":3,\"charge\":[{\"from\":0,\"to\":2,\"value\":0,\"currency\":\"INR\",\"permitted\":\"F\"}],\"Remark\":\"no show is when a pax fails to change/cancel booking atleast 02 hours before departure of the flight being changed/cancelled\"},{\"condition\":4,\"charge\":[{\"from\":451,\"to\":499,\"value\":0,\"currency\":\"INR\",\"permitted\":\"T\"}],\"Remark\":\"reservations booked more than 7 days prior to commencement of travel may be cancelled or amended within 48 hours of booking ticket without penalty.\"}]}]}]}]" }],
}

// The same flight's first fare: the GDS has no rule for its booking code, and
// says so inside Remarks (an object, not the usual array).
export const FARE_RULE_NO_FARE = {
  Status: 'Success',
  Error: null,
  FareRulesFlight: [{ Remarks: "{\"farekey\":\"DELBOM-AI2943-20261207-S-SU1YXR2I_D-O-100\",\"errorMessage\":\"NO FARE FOR BOOKING CODE-TRY OTHER PRICING OPTIONS\",\"errorCode\":\"911\",\"errorCategory\":\"EC\"}" }],
}
