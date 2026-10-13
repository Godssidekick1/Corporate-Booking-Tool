'use client'

import { useEffect, useState } from 'react'
import { flowStorage, type FlowExits } from '@/app/lib/book/flowStorage'

// The booking flow's exits for render (flowStorage.exits). Starts as the
// corporate defaults, which is what the server renders, and switches to the
// travel desk's after mount: sessionStorage is not readable on the server.
export function useFlowExits(): FlowExits {
  const [exits, setExits] = useState<FlowExits>({
    home: { href: '/dashboard', label: 'Dashboard' },
    trips: { href: '/bookings', label: 'My trips' },
  })
  // Synchronising with sessionStorage, which the server render cannot see.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setExits(flowStorage.exits()) }, [])
  return exits
}
