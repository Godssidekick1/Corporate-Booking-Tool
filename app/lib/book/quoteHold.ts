// ── How long a priced fare is held ───────────────────────────────────────────
// From the price step to the passenger step. A held quote is what add-passenger
// books from (the airline-side figures and the commercials); past this it is
// refused and the fare is priced again, so nobody books a fare the airline may
// have moved since. The fare page shows the time left.
//
// The same for every company: it is about how long a price stays true, not a
// company's preference.
// ─────────────────────────────────────────────────────────────────────────────

export const QUOTE_HOLD_MINUTES = 30

export const QUOTE_EXPIRED_MESSAGE =
  `This price was held for ${QUOTE_HOLD_MINUTES} minutes and has expired. Please go back and price this flight again.`
