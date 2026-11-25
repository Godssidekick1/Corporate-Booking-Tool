'use client'

import { useEffect } from 'react'
import { ErrorScreen } from '@/app/components/StatusScreen'

// A crash in the booking flow. A booking may already be held or ticketed at
// the airline by the time a page fails, so the screen says to look in My trips
// before booking again rather than simply "try again".
export default function BookingError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return (
    <ErrorScreen
      error={error}
      retry={retry}
      note="If you were confirming a booking, check My trips before booking again: the airline may already have it."
    />
  )
}
