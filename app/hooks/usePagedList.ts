'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// ── usePagedList ─────────────────────────────────────────────────────────────
// Page, search, debounce and loading for a server-paged list.
//
// THE BUG THIS EXISTS TO PREVENT
// Typing "acme" fires four requests. They can come back in any order, so a slow
// response for "ac" can land after the fast one for "acme" and overwrite the
// results with stale rows — the box says "acme" and the table shows matches for
// "ac". Every hand-rolled search in this app has that bug today.
//
// Two guards, because they fail differently:
//   - AbortController cancels a request that is already in flight, so the
//     browser stops waiting on work nobody wants.
//   - A monotonic request id is checked at the point of setState, because abort
//     is not instantaneous and a response can already be resolving when the
//     abort fires. The id is what actually makes the last write win.
//
// TWO LOADING FLAGS, NOT ONE
// `loading` is the first paint, where there is nothing on screen and a skeleton
// belongs. `refreshing` is every fetch after that, where the table is already
// rendered and should stay put — collapsing it to a skeleton on each keystroke
// makes a fast connection feel broken.
// ─────────────────────────────────────────────────────────────────────────────

export interface PagedResult<T> {
  items: T[]
  total: number
  page: number
  totalPages: number
  // The whole response body. A few endpoints ship lookup data alongside the page
  // — traveller profiles returns the client's bands and cost centres, which feed
  // dropdowns in the detail panel and are far too small to page. Exposing the
  // raw payload beats making those a second round trip.
  raw: Record<string, unknown> | null
  loading: boolean
  refreshing: boolean
  error: string
  search: string
  setSearch: (value: string) => void
  setPage: (page: number) => void
  refetch: () => void
}

interface Options {
  // Extra query params. Changing these resets to page 1, same as search does.
  params?: Record<string, string | number | boolean | null | undefined>
  // Skip fetching entirely — for a list that needs a selection first.
  enabled?: boolean
  debounceMs?: number
}

export function usePagedList<T>(endpoint: string, options: Options = {}): PagedResult<T> {
  const { params, enabled = true, debounceMs = 250 } = options

  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null)
  const [page, setPageState] = useState(1)
  const [search, setSearchState] = useState('')
  const [loading, setLoading] = useState(enabled)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // Serialised so the effect depends on the VALUE of params, not the identity
  // of the object. A caller writing `params={{ clientId }}` inline creates a new
  // object every render, which would otherwise refetch forever.
  const paramsKey = JSON.stringify(params ?? {})

  const requestId = useRef(0)
  const hasLoaded = useRef(false)

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false)
      return
    }

    const controller = new AbortController()
    const id = ++requestId.current

    // First load shows a skeleton; everything after keeps the table and dims it.
    if (hasLoaded.current) setRefreshing(true)
    else setLoading(true)

    const timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams()
        qs.set('page', String(page))
        if (search.trim()) qs.set('search', search.trim())
        for (const [key, value] of Object.entries(JSON.parse(paramsKey) as Record<string, unknown>)) {
          if (value !== null && value !== undefined && value !== '') qs.set(key, String(value))
        }

        const res = await fetch(`${endpoint}?${qs}`, { signal: controller.signal })
        const data = await res.json()

        // The guard that actually matters: a response from an older keystroke
        // is discarded even if it arrives last.
        if (id !== requestId.current) return

        if (!data.ok) {
          setError(data.error || 'Could not load.')
          setItems([])
          setTotal(0)
          return
        }

        setError('')
        setRaw(data)
        setItems(data.items ?? [])
        setTotal(data.total ?? 0)
        setTotalPages(data.totalPages ?? 1)
      } catch (err) {
        // An abort is the expected outcome of typing, not a failure to report.
        if ((err as Error)?.name === 'AbortError') return
        if (id !== requestId.current) return
        setError('Could not load.')
      } finally {
        if (id === requestId.current) {
          hasLoaded.current = true
          setLoading(false)
          setRefreshing(false)
        }
      }
    }, hasLoaded.current ? debounceMs : 0)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [endpoint, page, search, paramsKey, enabled, debounceMs, reloadKey])

  // Searching from page 4 would otherwise land on an empty page, since the new
  // result set is nearly always shorter than the old one.
  const setSearch = useCallback((value: string) => {
    setSearchState(value)
    setPageState(1)
  }, [])

  const setPage = useCallback((next: number) => {
    setPageState(Math.max(1, next))
  }, [])

  const refetch = useCallback(() => setReloadKey(k => k + 1), [])

  // Same reason as search: deleting the last row on page 5 leaves you on a page
  // that no longer exists, showing an empty table with no explanation.
  useEffect(() => {
    // Clamping an out-of-range page IS synchronising state to an external
    // value — the row count the server just reported.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!loading && !refreshing && page > totalPages) setPageState(totalPages)
  }, [page, totalPages, loading, refreshing])

  return {
    items, total, page, totalPages, raw,
    loading, refreshing, error,
    search, setSearch, setPage, refetch,
  }
}
