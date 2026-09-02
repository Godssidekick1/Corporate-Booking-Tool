import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission, getAccessibleClientIds } from '@/app/lib/permissions/requireTmcPermission'

// ── GET /api/tmc/stats ───────────────────────────────────────────────────────
// Booking activity across the TMC's clients, for the dashboard.
//
// Aggregated here rather than in the browser because the client list is scoped
// per caller (a 'tc' only sees clients they have access to) and shipping every
// booking row to the browser to count them would leak the ones they cannot see.
//
// Everything is derived from bookings.created_at, so "last 30 days" is booking
// date, not travel date.
// ─────────────────────────────────────────────────────────────────────────────

const RECENT_DAYS = 30
const TREND_WEEKS = 8

interface ClientStat {
  clientId: string
  name: string
  employees: number
  bookings: number
  recentBookings: number
  spend: number
  lastBookingAt: string | null
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  // No specific clientId — this is a whole-portfolio view, and which slice of
  // it the caller may see is decided by getAccessibleClientIds below.
  const auth = await requireTmcPermission(service, user.id, 'view_reports')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  const { data: caller } = await service
    .from('employees')
    .select('role')
    .eq('id', user.id)
    .single()

  const accessibleIds = await getAccessibleClientIds(service, user.id, caller?.role ?? 'tc')

  let clientQuery = service
    .from('clients')
    .select('id, name, status, created_at')
    .eq('tmc_id', auth.tmcId)

  // null means "every client at this TMC" (tmc_admin); an array is the explicit
  // allow-list for a travel counsellor.
  if (accessibleIds !== null) {
    if (accessibleIds.length === 0) {
      return Response.json({ ok: true, totals: emptyTotals(), clients: [], trend: [] })
    }
    clientQuery = clientQuery.in('id', accessibleIds)
  }

  const { data: clientRows, error: clientError } = await clientQuery

  if (clientError) {
    return Response.json({ error: clientError.message }, { status: 500 })
  }

  const clientIds = (clientRows ?? []).map(c => c.id)

  if (clientIds.length === 0) {
    return Response.json({ ok: true, totals: emptyTotals(), clients: [], trend: [] })
  }

  const [{ data: employees }, { data: bookings }] = await Promise.all([
    service.from('employees').select('id, client_id, status').in('client_id', clientIds),
    service
      .from('bookings')
      .select('id, client_id, total_cost, status, created_at')
      .in('client_id', clientIds),
  ])

  const employeesByClient = new Map<string, number>()
  for (const e of employees ?? []) {
    if (e.status === 'deactivated') continue
    employeesByClient.set(e.client_id, (employeesByClient.get(e.client_id) ?? 0) + 1)
  }

  const recentCutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000

  const bookingsByClient = new Map<string, { total: number; recent: number; spend: number; last: string | null }>()
  for (const b of bookings ?? []) {
    const entry = bookingsByClient.get(b.client_id) ?? { total: 0, recent: 0, spend: 0, last: null }
    entry.total += 1
    entry.spend += Number(b.total_cost ?? 0)
    if (new Date(b.created_at).getTime() >= recentCutoff) entry.recent += 1
    if (!entry.last || b.created_at > entry.last) entry.last = b.created_at
    bookingsByClient.set(b.client_id, entry)
  }

  const clients: ClientStat[] = (clientRows ?? []).map(c => {
    const b = bookingsByClient.get(c.id)
    return {
      clientId: c.id,
      name: c.name,
      employees: employeesByClient.get(c.id) ?? 0,
      bookings: b?.total ?? 0,
      recentBookings: b?.recent ?? 0,
      spend: b?.spend ?? 0,
      lastBookingAt: b?.last ?? null,
    }
  }).sort((a, b) => b.bookings - a.bookings)

  // Weekly buckets, oldest first, so the dashboard can draw a trend without
  // re-deriving date maths in the browser.
  const trend: { weekStart: string; bookings: number }[] = []
  const now = new Date()
  for (let i = TREND_WEEKS - 1; i >= 0; i--) {
    const start = new Date(now)
    start.setUTCHours(0, 0, 0, 0)
    start.setUTCDate(start.getUTCDate() - i * 7)
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 7)

    const count = (bookings ?? []).filter(b => {
      const t = new Date(b.created_at).getTime()
      return t >= start.getTime() && t < end.getTime()
    }).length

    trend.push({ weekStart: start.toISOString().slice(0, 10), bookings: count })
  }

  const bookingCounts = clients.map(c => c.bookings)
  const active = clients.filter(c => c.bookings > 0)

  return Response.json({
    ok: true,
    totals: {
      clients: clients.length,
      // Clients with no bookings at all are the ones worth chasing, so they get
      // counted separately rather than being averaged away.
      activeClients: active.length,
      employees: [...employeesByClient.values()].reduce((a, b) => a + b, 0),
      bookings: bookingCounts.reduce((a, b) => a + b, 0),
      recentBookings: clients.reduce((a, c) => a + c.recentBookings, 0),
      spend: clients.reduce((a, c) => a + c.spend, 0),
      maxBookings: bookingCounts.length ? Math.max(...bookingCounts) : 0,
      minBookings: bookingCounts.length ? Math.min(...bookingCounts) : 0,
      // Averaged across clients that have actually booked — including dormant
      // ones drags the number toward zero and hides how the live ones behave.
      avgBookings: active.length
        ? Math.round((active.reduce((a, c) => a + c.bookings, 0) / active.length) * 10) / 10
        : 0,
    },
    clients,
    trend,
  })
}

function emptyTotals() {
  return {
    clients: 0, activeClients: 0, employees: 0, bookings: 0,
    recentBookings: 0, spend: 0, maxBookings: 0, minBookings: 0, avgBookings: 0,
  }
}
