// ── The airline's own PNR ────────────────────────────────────────────────────
// The GDS PNR (bookings.pnr) is the provider's reservation. Each airline also
// keeps its own record locator, which the provider reports per flight leg as
// FlightDetails[].AirLinePNR in the Ticket response -- what a traveller quotes
// at the airline's counter, and what refunds are matched on. Legs on one
// airline share it; a journey across airlines can carry several, kept in leg
// order and joined with " / ". Empty strings (the provider's "not issued
// yet") are skipped. Null when there is none.
// ─────────────────────────────────────────────────────────────────────────────

export function airlinePnrFrom(flightDetails: unknown): string | null {
  if (!Array.isArray(flightDetails)) return null
  const seen: string[] = []
  for (const leg of flightDetails) {
    const value = (leg as { AirLinePNR?: unknown } | null)?.AirLinePNR
    const pnr = typeof value === 'string' ? value.trim() : ''
    if (pnr && !seen.includes(pnr)) seen.push(pnr)
  }
  return seen.length ? seen.join(' / ') : null
}
