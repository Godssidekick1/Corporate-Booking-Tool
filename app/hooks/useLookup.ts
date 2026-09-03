'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// ── useLookup ────────────────────────────────────────────────────────────────
// Feeds a server-backed SearchableSelect.
//
// The problem it solves is not "fetch some options" — it is that a picker over
// an unbounded table has to answer two questions at once:
//
//   1. What should the dropdown show right now?  (a page of search results)
//   2. What is the CURRENT selection called?     (a row that is usually not in
//                                                 those results)
//
// Deriving the label from the visible options answers 1 and silently breaks 2:
// select a client, type anything, and the field goes blank because the selected
// row fell out of the result set. So this keeps a label cache — every row it has
// ever seen — and resolves a cache miss with a targeted `?ids=` fetch rather
// than paging until the row turns up.
// ─────────────────────────────────────────────────────────────────────────────

export interface LookupOption {
  id: string
  label: string
  sublabel?: string
}

interface Options {
  // Extra query params, e.g. { clientId } for an employee picker.
  params?: Record<string, string | number | null | undefined>
  enabled?: boolean
  // Maps an API row to the option shape. Defaults to { id, name }.
  toOption?: (row: Record<string, unknown>) => LookupOption
}

const defaultToOption = (row: Record<string, unknown>): LookupOption => ({
  id: String(row.id),
  label: String(row.name ?? row.full_name ?? row.code ?? row.id),
  sublabel: row.email ? String(row.email) : undefined,
})

export function useLookup(endpoint: string, selectedId: string, options: Options = {}) {
  const { params, enabled = true, toOption = defaultToOption } = options

  const [items, setItems] = useState<LookupOption[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  // The resolved label is STATE, not a ref read at render time. A ref mutated in
  // an effect and read during render neither triggers the re-render that would
  // show it nor is safe to read while rendering — it has to be state for the
  // value to actually reach the input.
  const [selectedLabel, setSelectedLabel] = useState('')

  // The cache itself stays a ref: it is written from effects and never read
  // during render, so it does not need to cause a render on its own.
  const labels = useRef(new Map<string, string>())
  const requestId = useRef(0)
  const paramsKey = JSON.stringify(params ?? {})

  // Held in a ref so the search effect can read the CURRENT selection without
  // depending on it — depending on selectedId would refire the search every time
  // someone picks an option.
  const selectedIdRef = useRef(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  // Same last-write-wins guard as usePagedList: type-ahead fires overlapping
  // requests and an earlier one can resolve last.
  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()
    const id = ++requestId.current
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)

    ;(async () => {
      try {
        const qs = new URLSearchParams()
        if (query.trim()) qs.set('search', query.trim())
        for (const [key, value] of Object.entries(JSON.parse(paramsKey) as Record<string, unknown>)) {
          if (value !== null && value !== undefined && value !== '') qs.set(key, String(value))
        }

        const res = await fetch(`${endpoint}?${qs}`, { signal: controller.signal })
        const data = await res.json()
        if (id !== requestId.current || !data.ok) return

        const mapped = (data.items ?? []).map(toOption)
        for (const o of mapped) labels.current.set(o.id, o.label)
        setItems(mapped)

        // Results may include the current selection; take its label while we
        // have it, rather than making the ?ids= round trip below.
        const hit = labels.current.get(selectedIdRef.current)
        if (hit) setSelectedLabel(hit)
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    })()

    return () => controller.abort()
    // toOption is intentionally excluded: callers pass an inline arrow, which is
    // a new identity every render and would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, query, paramsKey, enabled])

  // Resolve a selection whose label we have never seen — a value restored from
  // saved state, or one whose row has scrolled out of the current results.
  useEffect(() => {
    if (!enabled) return

    // Syncing the displayed label to the selection, which is the caller's
    // state, not this hook's — the definition of synchronising with something
    // outside.
    if (!selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedLabel('')
      return
    }

    const cached = labels.current.get(selectedId)
    if (cached) {
      setSelectedLabel(cached)
      return
    }

    let cancelled = false
    fetch(`${endpoint}?ids=${selectedId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled || !data.ok) return
        for (const row of data.items ?? []) {
          const o = toOption(row)
          labels.current.set(o.id, o.label)
        }
        const resolved = labels.current.get(selectedId)
        if (resolved) setSelectedLabel(resolved)
      })
      .catch(() => {})

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, selectedId, enabled])

  const onSearch = useCallback((q: string) => setQuery(q), [])

  return { options: items, onSearch, loading, selectedLabel }
}
