import { types as pgTypes } from 'pg'

// ── Matching PostgREST's JSON representation ─────────────────────────────────
// THE MOST DANGEROUS DIFFERENCE BETWEEN THE TWO DRIVERS, and the one least
// likely to announce itself.
//
// PostgREST serialises a row to JSON, so `numeric` arrives as a NUMBER and
// `timestamptz` as an ISO STRING. node-postgres decodes the wire protocol with
// its own rules, and by default gives:
//
//   numeric(12,2)  ->  "12345.67"   (string, to avoid float precision loss)
//   bigint         ->  "42"         (string, because it can exceed 2^53)
//   timestamptz    ->  Date         (an object)
//   date           ->  Date         (at LOCAL midnight, which can shift the day)
//
// Left alone, each of those is a silent corruption rather than an error:
//
//   * `sell_total` and `total_cost` are numeric(12,2). `"100.00" + 5` is
//     "100.005" -- string concatenation, not addition. And `"9" > "10"` is
//     true, so a spend limit compared lexicographically passes the wrong
//     bookings.
//
//   * resolveCommercials, resolveFop and resolveDealCodes all break the final
//     tie with `b.rule.created_at.localeCompare(a.rule.created_at)`. Date has
//     no localeCompare, so a Date there is a TypeError in the money path.
//
//   * `date` decoded to a local-midnight Date is 2026-09-22 in IST and
//     2026-09-21 in UTC. Travel dates would move by a day depending on where
//     the server runs.
//
// So the parsers below are not a preference. They are what keeps the 537 call
// sites reading the same JavaScript values they have always read.
//
// setTypeParser is global to the pg module, which is why this is called once
// from pool.ts before any connection is opened rather than per query.
//
// IMPORTED FROM 'pg', NOT FROM 'pg-types'. Under plain Node the two resolve to
// the same module instance, so registering on either works -- but Next's
// bundler can give this file its own copy of pg-types while the pooled client
// keeps another, and the parsers then register on an object nobody reads.
// That failed silently: the tests passed and a live route still answered
// sell_total as the string "10717.00". Reaching types through the pg package
// we already import makes one instance the only possibility.
// ─────────────────────────────────────────────────────────────────────────────

const NUMERIC = 1700
const INT8 = 20
const TIMESTAMPTZ = 1184
const DATE = 1082

let applied = false

export function applyTypeParsers(): void {
  if (applied) return
  applied = true

  // numeric -> number. Precision beyond IEEE-754 would be lost, which is why
  // pg defaults to a string; the schema's widest is numeric(14,2), and 14
  // digits is comfortably inside the 15-17 significant digits a double holds
  // exactly. If a column ever needs more, it needs a decimal type in the
  // application too, not a different parser.
  pgTypes.setTypeParser(NUMERIC, (value: string) => (value === null ? null : Number(value)))

  // bigint -> number. No bigint columns exist in baseline.sql today; this is
  // here because an un-cast count(*) comes back as int8, and PostgREST would
  // have reported that as a number.
  pgTypes.setTypeParser(INT8, (value: string) => (value === null ? null : Number(value)))

  // timestamptz -> ISO string, not a Date.
  //
  // pg's own text for this type is "2026-09-22 07:27:09.861+00" -- a space
  // rather than a T, and an offset rather than Z. That parses in V8 but is not
  // ISO 8601, and it does not sort lexicographically against a value with a
  // different offset. Normalising through Date fixes both.
  //
  // Costs sub-millisecond precision: PostgreSQL stores microseconds and
  // toISOString emits milliseconds. Nothing in this schema uses a timestamp for
  // anything finer than ordering and display.
  pgTypes.setTypeParser(TIMESTAMPTZ, (value: string) =>
    value === null ? null : new Date(value).toISOString()
  )

  // date -> the raw "YYYY-MM-DD" text, which is exactly what PostgREST emits.
  // Deliberately NOT routed through Date: a date has no time and no zone, so
  // constructing one invents both and can land on the previous day.
  pgTypes.setTypeParser(DATE, (value: string) => value)
}
