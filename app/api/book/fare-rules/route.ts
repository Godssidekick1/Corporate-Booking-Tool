import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import { quoteForRules } from '@/app/lib/repositories/bookings'
import { rulesForQuote } from '@/app/lib/book/quoteFareRules'
import { travellerFareRules } from '@/app/lib/book/fareRules'

// ── POST /api/book/fare-rules ────────────────────────────────────────────────
// The airline's fare rules for a fare just priced, asked separately from the
// price so the fare page never waits for them (they take 7-12 s; the page
// shows the price, then the rules when they arrive).
//
// Body: { key, referenceNo } — the quote /api/book/price saved. Only whoever
// priced it may ask (as only they may book it). Every key sent to the airline
// is read from that quote, never from the request: the rules are kept on the
// quote, copied onto the booking and used for the refund penalty.
//
// Answers { ok: true, fareRules } (null when the airline gave none), with the
// TMC's deal code removed. Rules already kept are returned without asking the
// airline again.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const body = await req.json().catch(() => null) as { key?: unknown; referenceNo?: unknown } | null
  const key = typeof body?.key === 'string' ? body.key.trim() : ''
  const referenceNo = typeof body?.referenceNo === 'string' ? body.referenceNo.trim() : ''
  if (!key || !referenceNo) {
    return Response.json({ ok: false, error: 'key and referenceNo are required' }, { status: 400 })
  }

  const quote = await quoteForRules(db, key, referenceNo)
  // Someone else's quote reads as none at all.
  if (!quote || quote.priced_by !== user.id) {
    console.info('[fare rules] refused:', quote ? 'priced by someone else' : 'no such quote')
    return Response.json({ ok: false, error: 'This fare is no longer priced. Choose it again.', code: 'QUOTE_NOT_FOUND' }, { status: 404 })
  }

  // One line per request (the quote's id, never its keys): whether the rules
  // were kept already, came from the airline and how long it took, or did not.
  const t0 = Date.now()
  const kept = !!quote.fare_rules
  const rules = await rulesForQuote(db, quote)
  console.info(`[fare rules] quote ${quote.id}: ${kept ? 'already kept'
    : !quote.search_key ? 'no search key (priced before it was kept)'
    : rules ? `from the airline in ${Date.now() - t0} ms (${rules.sectors.length} sector${rules.sectors.length === 1 ? '' : 's'})`
    : `none after ${Date.now() - t0} ms`}`)
  return Response.json({ ok: true, fareRules: travellerFareRules(rules) })
})
