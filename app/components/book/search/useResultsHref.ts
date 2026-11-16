'use client'

import { useEffect, useState } from 'react'
import { flowStorage } from '@/app/lib/book/flowStorage'

// Where "← Back to results" goes: the last search's results page (it shows the
// same list again), or the search form when this tab has none. Read after
// mount: the server render cannot see sessionStorage, and reading it during
// render would hydrate different markup than was sent.
export function useResultsHref(): string {
  const [href, setHref] = useState('/book/flights')
  // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from sessionStorage
  useEffect(() => { setHref(flowStorage.resultsHref()) }, [])
  return href
}
