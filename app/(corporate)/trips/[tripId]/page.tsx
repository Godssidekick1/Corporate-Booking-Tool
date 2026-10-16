'use client'

import { useParams } from 'next/navigation'
import TripWorkspace from '@/app/components/trips/TripWorkspace'

// ── /trips/[tripId] ──────────────────────────────────────────────────────────
// One trip, for its traveller or a colleague who looks after it (an admin who
// set it up or books into it). The page itself is shared with the travel
// desk's (/tmc/trips/[tripId]): app/components/trips/TripWorkspace.
// ─────────────────────────────────────────────────────────────────────────────

export default function TripPage() {
  const { tripId } = useParams<{ tripId: string }>()
  return (
    <div style={{ background: '#F9FAFB', minHeight: '100vh' }}>
      <div className="page-frame narrow" style={{ fontFamily: "'Inter', -apple-system, sans-serif" }}>
        <TripWorkspace tripId={tripId} home="/bookings" backHref="/book" backLabel="Trips" />
      </div>
    </div>
  )
}
