import { redirect } from 'next/navigation'

// ── /book ────────────────────────────────────────────────────────────────────
// Used to be a "Trips" page: the same list as My trips with fewer flights and
// two more buttons. It is all on My trips now (/bookings), and "Book travel"
// in the sidebar goes straight to the flight search. Old links and bookmarks
// land on My trips.
// ─────────────────────────────────────────────────────────────────────────────

export default function BookPage(): never {
  redirect('/bookings')
}
