'use client'

import { useParams } from 'next/navigation'
import TripWorkspace from '@/app/components/trips/TripWorkspace'

// ── /tmc/trips/[tripId] ──────────────────────────────────────────────────────
// A traveller's trip, as the travel desk keeps it: its details, flights added
// for the traveller, and its sign-off submitted on their behalf -- the
// company's own approvers decide. The same page as the company side's
// (app/components/trips/TripWorkspace); who may open it is the booking-for
// rule (app/lib/trips/access.ts), and the page gate asks "Book for
// travellers" of a counsellor (app/lib/navigation/tmcAccess.ts).
// ─────────────────────────────────────────────────────────────────────────────

export default function DeskTripPage() {
  const { tripId } = useParams<{ tripId: string }>()
  return (
    <div className="page-frame medium" style={{ fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <TripWorkspace tripId={tripId} home="/tmc/book" backHref="/tmc/book" backLabel="Book travel" />
    </div>
  )
}
