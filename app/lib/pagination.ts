// ── Pagination ───────────────────────────────────────────────────────────────
// One definition of how a paged endpoint reads its params and shapes its
// response, because fifteen endpoints inventing their own is how "page" ends up
// 0-based in one place and 1-based in another.
//
// Every list in this app previously fetched and rendered every row. That works
// until a TMC has a few hundred travellers, and the failure is quiet: a slower
// page, then a much slower page, then a request that times out.
//
// SEARCH BELONGS ON THE SERVER, TOO
// Filtering a truncated list in the browser silently hides matches — search page
// three for a name that lives on page seven and you get nothing, with no way to
// tell that from "no such person". So `search` travels with the page params and
// is applied before the range.
// ─────────────────────────────────────────────────────────────────────────────

// Fixed rather than caller-supplied: a client that can ask for ?limit=100000 has
// no pagination, it has an opt-out. Endpoints that genuinely need a different
// size pass it explicitly in code.
export const PAGE_SIZE = 10

export interface PageParams {
  page: number
  pageSize: number
  // Inclusive bounds for Supabase's .range(), which is inclusive at both ends —
  // .range(0, 9) is ten rows, not eleven.
  from: number
  to: number
  search: string
}

export function parsePageParams(
  searchParams: URLSearchParams,
  pageSize: number = PAGE_SIZE
): PageParams {
  const raw = Number(searchParams.get('page'))
  // NaN, 0, negatives and fractions all collapse to page 1 rather than throwing.
  // A bad page number in a URL should show the first page, not an error screen.
  const page = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1
  const from = (page - 1) * pageSize

  return {
    page,
    pageSize,
    from,
    to: from + pageSize - 1,
    search: searchParams.get('search')?.trim() ?? '',
  }
}

export interface PagedResponse<T> {
  ok: true
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export function pagedResponse<T>(items: T[], total: number | null, params: PageParams): PagedResponse<T> {
  const count = total ?? items.length
  return {
    ok: true,
    items,
    page: params.page,
    pageSize: params.pageSize,
    total: count,
    // At least 1 so the UI never renders "Page 1 of 0" on an empty list.
    totalPages: Math.max(1, Math.ceil(count / params.pageSize)),
  }
}

// ── escapeFilterValue ────────────────────────────────────────────────────────
// PostgREST parses the string handed to .or() — commas separate conditions and
// parentheses group them. A search box containing "Smith, John" would therefore
// change the SHAPE of the filter rather than being matched literally, and a
// stray backslash or bracket can make the whole query fail.
//
// Stripped rather than escaped: PostgREST has no reliable escape for these
// inside an .or() list, and dropping them degrades the match instead of
// breaking the request.
// ─────────────────────────────────────────────────────────────────────────────
export function escapeFilterValue(value: string): string {
  return value.replace(/[,()\\*]/g, '').trim()
}

// Builds an `or` filter across several text columns for one search term.
// Returns null when there is nothing usable to search for, so callers can skip
// applying a filter rather than applying an empty one that matches nothing.
export function ilikeAcross(columns: string[], search: string): string | null {
  const safe = escapeFilterValue(search)
  if (!safe) return null
  return columns.map(col => `${col}.ilike.%${safe}%`).join(',')
}

// ── paginateInMemory ─────────────────────────────────────────────────────────
// For the few endpoints whose rows cannot be produced by a single query —
// deal-code coverage resolves per client in memory, and booking status is
// derived rather than stored. Kept here so those screens still return the same
// envelope and the client cannot tell the difference.
// ─────────────────────────────────────────────────────────────────────────────
export function paginateInMemory<T>(rows: T[], params: PageParams): PagedResponse<T> {
  return pagedResponse(rows.slice(params.from, params.from + params.pageSize), rows.length, params)
}
