# Database changes since 2026-10-22

15 migrations were added after 2026-10-22 (up to commit 07da43c). Each runs in its own
transaction through `scripts/migrate.mjs`, which records it in `schema_migrations`.
`node scripts/migrate.mjs --status` on your database lists which of these it still needs.

| # | Migration | Added |
|---|---|---|
| 1 | `20261022000000_drop_approval_amount_rules.sql` | 2026-10-22 |
| 2 | `20261102000000_sign_in_tables_system_only.sql` | 2026-11-02 |
| 3 | `20261102000100_foreign_key_indexes.sql` | 2026-11-02 |
| 4 | `20261103000000_drop_auth_stub.sql` | 2026-11-03 |
| 5 | `20261105000000_booking_cancellation.sql` | 2026-11-05 |
| 6 | `20261110000000_refunds.sql` | 2026-11-10 |
| 7 | `20261111000000_round_trip_pairs.sql` | 2026-11-11 |
| 8 | `20261116000000_fare_rules.sql` | 2026-11-16 |
| 9 | `20261117000000_quote_search_key.sql` | 2026-11-17 |
| 10 | `20261117000100_provider_unconfirmed.sql` | 2026-11-17 |
| 11 | `20261117000200_reapproval_needed.sql` | 2026-11-17 |
| 12 | `20261118000000_choice_context.sql` | 2026-11-18 |
| 13 | `20261118000100_requested_total.sql` | 2026-11-18 |
| 14 | `20261119000000_signin_challenges.sql` | 2026-11-19 |
| 15 | `20261120000000_signin_challenges_delete_on_use.sql` | 2026-11-20 |

---

## 1. `20261022000000_drop_approval_amount_rules.sql`

**The old approval amounts, removed from stored policies**
Problem: "Auto-approve under" and "Finance approval over" left the policy
editor and the verdict on 2026-10-20 (a spend question for expense
management, not a flight's policy), but their rows stayed in the stored
versions, read by nothing and shown by nothing, until a group was saved again.

Change: those rows are deleted, in every version. Nothing reads them, so no
verdict, approval or screen changes.

Safe to apply twice.

**What it runs:**

- `delete from public.policy_rules where travel_type = 'approval' or limit_key in ('auto_approve_under', 'finance_approval_over')`

---

## 2. `20261102000000_sign_in_tables_system_only.sql`

**The sign-in tables answer to the system scope only**
Problem: accounts, sessions, auth_tokens, auth_attempts, platform_admins
and rate_limits were left allow-all to the app role
(20261012000000_tenant_policies, "shared"): they hold no tenant's rows, and
only app/lib/auth read them. But allow-all meant any query in a tenant's
request could read every account's password hash and every live session,
across tenants, had one been written to.

Change: each admits rows only when app.scope is 'system'. The app reaches
them only through app/lib/repositories/{accounts,rateLimits}.ts and
tmcs.platformAdmin, which run every statement as the system
(app/lib/db/systemScope.ts), including inside a tenant's transaction.

One tenant-side question remains -- "can this person sign in?", a column of
the people lists -- and it gets one narrow answer: account_can_sign_in()
says yes or no for one id, and nothing else. It runs as the owner (security
definer) with a fixed search_path, so it cannot be redirected to another
table. The id it is asked about comes from an employees row the caller can
already see.

The owner bypasses row-level security: migrations and scripts unaffected.
Safe to apply twice.

**What it runs:**

- `DO $$…$$ (a block that loops over tables: see the file for what it does)`
- `create or replace function public.account_can_sign_in(employee uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$…$$`
- `revoke all on function public.account_can_sign_in(uuid) from public`
- `grant execute on function public.account_can_sign_in(uuid) to cbt_app`

---

## 3. `20261102000100_foreign_key_indexes.sql`

**Every foreign key gets an index**
Problem: 41 foreign-key columns had no index (24 of them pointing at
employees: created_by, assigned_by, granted_by, confirmed_by...). PostgreSQL
indexes the referenced side, never the referencing one, so deleting one
employee or client checks each referring table by reading it whole -- a
cost that grows with the data. Not visible yet: on the 2026-10-22 dump,
removing the whole 2,000-client demo TMC took 0.6 s without these indexes
and 0.5 s with them (one bulk delete per table amortises the scans). The
indexes are for the single-row deletes at scale, and the guard below.

Change: an index on the columns of every foreign key that no index leads
with, named <table>_<columns>_fk_idx. Found here, from the catalog, rather
than listed by hand: the same answer on every database this runs on, and
nothing to miss. tests/schema.test.ts keeps it that way: a new foreign key
without an index fails the suite.

Plain (not concurrent) creation, inside the migration's transaction: the
tables are small (the largest, bookings, about 30 MB). Safe to apply twice.

**What it runs:**

- `DO $$…$$ (a block that loops over tables: see the file for what it does)`

---

## 4. `20261103000000_drop_auth_stub.sql`

**The leftover auth schema goes**
Problem: every database restored from the old schema capture carries an
`auth` schema holding one function, auth.uid(): a stand-in the old restore
script created so that policies written for the previous hosted platform
would load. Those policies went in 20260925000000; nothing has called the
function since (tests/schema.test.ts checks no policy, function or view in
public refers to auth), and sign-in has its own tables (accounts, sessions).

Change: drop the function, then the schema if that leaves it empty. Only
the stand-in: a schema that also holds a users table is a real
authentication service's, and is left alone. Safe to apply twice.

**What it runs:**

- `DO $$…$$ (a block that loops over tables: see the file for what it does)`

---

## 5. `20261105000000_booking_cancellation.sql`

**Cancelling a booking**
Until now a booking could be made but never undone from here: the
provider's CancelBooking call existed in the client and nothing used it.
POST /api/book/[bookingId]/cancel now cancels, and this records it.

  bookings.cancelled_at, cancelled_by, cancellation_reason
      who cancelled, when and why (the reason is also sent to the provider
      as CancellationRemarks)
  bookings.cancellation
      what the provider answered: its cancel and change-request statuses,
      the refund it reports, the airline's cancellation charge and the tax
      on it, its reference numbers. Airline-side money: the desk sees all
      of it, a traveller only the charges (the route decides).
  bookings.cancel_started_at
      set while a cancellation is with the provider, so a second click (or
      a second tab) cannot send a second one. Cleared when the provider
      refuses; one older than two minutes counts as abandoned.
  bookings.status 'cancel_requested'
      the provider accepted the request but has not yet confirmed it
      cancelled (a ticketed booking may be settled by the airline later)
  approvals.status 'withdrawn'
      the traveller or booker cancelled a booking that was still waiting
      for approval; its open steps close as withdrawn, not rejected

Safe to apply twice.

**What it runs:**

- `alter table public.bookings add column if not exists cancelled_at timestamptz, add column if not exists cancelled_by uuid references public.employees(id) on delete set null, add column if not exists cancellation_reaso…`
- `create index if not exists bookings_cancelled_by_fk_idx on public.bookings (cancelled_by)`
- `alter table public.bookings drop constraint if exists bookings_cancellation_reason_check`
- `alter table public.bookings add constraint bookings_cancellation_reason_check check (cancellation_reason is null or char_length(cancellation_reason) <= 500)`
- `alter table public.bookings drop constraint if exists bookings_status_check`
- `alter table public.bookings add constraint bookings_status_check check (status = any (array['pending_approval', 'approved', 'approval_misconfigured', 'rejected', 'priced', 'passenger_added', 'held', 'ticketed', 'cance…`
- `alter table public.approvals drop constraint if exists approvals_status_check`
- `alter table public.approvals add constraint approvals_status_check check (status = any (array['pending', 'approved', 'rejected', 'superseded', 'escalated', 'withdrawn']))`

---

## 6. `20261110000000_refunds.sql`

**Refunds for cancelled tickets**
Problem: a cancelled ticket (20261105000000_booking_cancellation) records
what the provider said, and nothing more. Nobody works out what the
company gets back, nothing records it, and there is no credit note.

Change:
  refunds               one row per cancelled passenger ticket, created
                        'pending' when the booking is cancelled; the TMC
                        processes it (the lines it settled on are frozen,
                        a credit note number is issued) or rejects it
  refund_attachments    documents on a refund (PDF/JPG/PNG, at most 5 MB),
                        kept in the database so backups need nothing extra
  credit_note_counters  the last credit note number per TMC and financial
                        year, taken inside the processing transaction:
                        no gaps, no duplicates
  clients.refund_*      the TMC's refund rule for each client: whether
                        markup and the processing fee go back, its own
                        cancellation fee, and the GST rate on its charges
  bookings.airline_pnr  the airline's own PNR, captured at ticketing

Tenant rows like search_fares: tmc_id filled from the client, the same
app_access rule, moved with the client. Safe to apply twice.

**What it runs:**

- `alter table public.bookings add column if not exists airline_pnr text`
- `alter table public.clients add column if not exists refund_markup boolean not null default false, add column if not exists refund_processing_fee boolean not null default false, add column if not exists tmc_cancellatio…`
- `alter table public.clients drop constraint if exists clients_refund_rule_check`
- `alter table public.clients add constraint clients_refund_rule_check check ( tmc_cancellation_fee >= 0 and tmc_cancellation_fee_unit in ('amount', 'percent') and (tmc_cancellation_fee_unit = 'amount' or tmc_cancellatio…`
- `create table if not exists public.refunds ( id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id) on delete cascade, tmc_id uuid, booking_id uuid not null references publ…`
- `create unique index if not exists refunds_credit_note_idx on public.refunds (tmc_id, credit_note_no) where credit_note_no is not null`
- `create index if not exists refunds_queue_idx on public.refunds (tmc_id, status, created_at desc)`
- `create index if not exists refunds_client_id_fk_idx on public.refunds (client_id)`
- `create index if not exists refunds_processed_by_fk_idx on public.refunds (processed_by)`
- `create table if not exists public.refund_attachments ( id uuid primary key default gen_random_uuid(), refund_id uuid not null references public.refunds(id) on delete cascade, client_id uuid not null references public.…`
- `create index if not exists refund_attachments_refund_id_fk_idx on public.refund_attachments (refund_id)`
- `create index if not exists refund_attachments_client_id_fk_idx on public.refund_attachments (client_id)`
- `create index if not exists refund_attachments_uploaded_by_fk_idx on public.refund_attachments (uploaded_by)`
- `create index if not exists refund_attachments_tmc_idx on public.refund_attachments (tmc_id)`
- `create table if not exists public.credit_note_counters ( tmc_id uuid not null references public.tmcs(id) on delete cascade, financial_year text not null check (financial_year ~ '^\d{4}-\d{2}$'), last_no integer not nu…`
- `DO $$…$$ (a block that loops over tables: see the file for what it does)`
- `alter table public.credit_note_counters enable row level security`
- `drop policy if exists app_access on public.credit_note_counters`
- `create policy app_access on public.credit_note_counters to cbt_app using ((select public.app_scope()) = 'system' or ((select public.app_client()) is null and tmc_id = (select public.app_tmc()))) with check ((select pu…`
- `grant select, insert, update on public.credit_note_counters to cbt_app`
- `create or replace function public.client_moved_tmc() returns trigger language plpgsql security definer set search_path = public as $$…$$`
- `insert into public.refunds (client_id, booking_id, passenger_index, ticket_number) select b.client_id, b.id, p.idx - 1, b.ticket_numbers[p.idx] from public.bookings b cross join lateral generate_series(1, greatest(1, …`

---

## 7. `20261111000000_round_trip_pairs.sql`

A domestic round trip booked as two one-way fares: two bookings, linked.

pair_id is the id of the pair's FIRST booking (the onward), on both rows. The
first carries it from the moment it is created (it waits, unsent for
approval, for its return); the return is linked to it when its passengers
are added. One approval is raised for the pair, on the first booking, and a
decision applies to both. Each booking is otherwise its own: priced, booked,
ticketed and cancelled on its own.

A special return fare (the airline's paired fare) is ONE booking, as any
combined round trip: no pair_id.

**What it runs:**

- `alter table public.bookings add column if not exists pair_id uuid references public.bookings (id) on delete set null`
- `create index if not exists bookings_pair_id_fk_idx on public.bookings (pair_id)`

---

## 8. `20261116000000_fare_rules.sql`

The airline's fare rules (flight/Non-LccFareRule), parsed: per sector, the
cancellation and change charges by time window before departure, no-show,
and the airline's own notes (app/lib/book/fareRules.ts).

Fetched when a fare is priced and held on the quote; copied onto the booking
when its passengers are added, so the traveller sees them on their booking
and the TMC prices a refund's airline penalty from them. Null when the
airline gave none (the fare page then says so) and for older bookings,
which the TMC may fetch again by PNR.

**What it runs:**

- `alter table public.price_quotes add column if not exists fare_rules jsonb`
- `alter table public.bookings add column if not exists fare_rules jsonb`

---

## 9. `20261117000000_quote_search_key.sql`

**The search a quote was priced from**
Problem: the airline's fare rules were fetched inside the price request,
which made the fare page wait for them; on the test system they take 7-12 s
and mostly missed the 8 s limit. They now have a request of their own
(/api/book/fare-rules), asked after the price is shown. That request reads
the fare's keys from the saved quote, never from the browser (the rules feed
the refund panel's penalty), and the airline's fare-rule call needs the
SEARCH's key, which the quote did not keep.

Change: price_quotes.search_key. Null on quotes priced before this; those
simply have no rules to fetch. Safe to apply twice.

**What it runs:**

- `alter table public.price_quotes add column if not exists search_key text`

---

## 10. `20261117000100_provider_unconfirmed.sql`

**A booking or ticket the airline may or may not have done**
Problem: airline calls had no time limit; they have one now. When Booking
or Ticket gets no answer in time, the airline may still have done it, so
the booking is neither failed nor held. Asking again blindly risks a second
PNR or a second ticket.

Change: bookings.provider_unconfirmed (which step went unanswered:
'booking' or 'ticket') and when. While it is set, the next attempt first
asks the airline what happened (GetBookingDetails) and records that,
instead of booking or ticketing again. Null for every booking until then.
Safe to apply twice.

**What it runs:**

- `alter table public.bookings add column if not exists provider_unconfirmed text`
- `alter table public.bookings add column if not exists provider_unconfirmed_at timestamptz`
- `alter table public.bookings drop constraint if exists bookings_provider_unconfirmed_check`
- `alter table public.bookings add constraint bookings_provider_unconfirmed_check check (provider_unconfirmed is null or provider_unconfirmed in ('booking', 'ticket'))`

---

## 11. `20261117000200_reapproval_needed.sql`

**A booking sent back to the traveller to ask for approval again**
Problem: an approver's "Refresh fare" can find the fare has risen beyond the
traveller's policy (past its grace). The approver should not decide on a
price the traveller never asked for; the traveller must ask again, with a
reason, or choose another flight (user, 2026-11-17).

Change: bookings.status gains 'reapproval_needed'. The open approval steps
are superseded; the traveller's "Ask for approval again" starts a new round
(pending_approval), and choosing another flight leaves this one behind.
Safe to apply twice.

**What it runs:**

- `alter table public.bookings drop constraint if exists bookings_status_check`
- `alter table public.bookings add constraint bookings_status_check check (status = any (array['pending_approval', 'approved', 'approval_misconfigured', 'rejected', 'priced', 'passenger_added', 'held', 'ticketed', 'cance…`

---

## 12. `20261118000000_choice_context.sql`

**What a fare was chosen from**
Problem: an approver sees the chosen fare but not what else was on offer,
and the search behind it (search_fares) is kept only two hours, far less
than an approval waits.

Change: bookings.choice_context, written once at add-passenger from that
search: the chosen fare (name, refundable, its search price), the cheapest
fare on the same flight, the cheapest flight on the same route that day,
and how many flights were shown. Sell-side figures only (the search's sell
estimates), never the airline's. Null when the search was not kept
(bookings made before this, or with no search behind them). Safe to apply
twice.

**What it runs:**

- `alter table public.bookings add column if not exists choice_context jsonb`

---

## 13. `20261118000100_requested_total.sql`

**The price an approval was asked at; refreshes stay with the approver**
Problem: a refreshed fare that rose and was out of policy went back to the
traveller to ask again (status reapproval_needed). On 2026-11-18 that sent
back a booking that was already out of policy for a ₹34 rise. Decided
(user, 2026-11-18): a refresh never takes a booking away from the approver.
They see the new price, how much it moved since it was asked for, and the
new policy verdict, and decide.

Change:
  1. bookings.requested_total: the sell total when approval was asked for
     (set at add-passenger, and again when a fare rise at confirmation
     starts a new round). A refresh changes sell_total, never this, so the
     approver's card can show "requested at ₹X · now ₹Y (+₹Z)".
     Backfilled from the sell total; a booking already refreshed upward and
     sent back takes the price from its audit record.
  2. Bookings sent back (reapproval_needed) return to their approver: the
     steps the send-back closed are pending again. The status value stays
     allowed (bookings_status_check) but nothing sets it any more.
Safe to apply twice.

**What it runs:**

- `alter table public.bookings add column if not exists requested_total numeric(12, 2)`
- `update public.bookings set requested_total = coalesce(sell_total, total_cost) where requested_total is null`
- `update public.bookings b set requested_total = (a.metadata ->> 'previousTotal')::numeric from ( select distinct on (entity_id) entity_id, metadata from public.audit_log where action = 'booking.returned_to_traveller' a…`
- `update public.approvals ap set status = 'pending', actioned_at = null, decision_note = null from public.bookings b where b.id = ap.booking_id and b.status = 'reapproval_needed' and ap.status = 'superseded' and ap.deci…`
- `update public.bookings set status = 'pending_approval', updated_at = now() where status = 'reapproval_needed'`

---

## 14. `20261119000000_signin_challenges.sql`

**One-time keys for a sealed password**
Problem: the sign-in request carried the password as plain text inside
HTTPS. Anything that logs request bodies after TLS ends (a corporate proxy
that inspects HTTPS, a saved network capture, a debugging tool) would hold
it, and could replay it (user, 2026-11-19; PCI DSS 8.3.2).

Change: before signing in, the browser asks for a challenge. The server
makes a one-off ECDH key pair, keeps the private half here, and returns the
public half. The browser seals the password to it (ECDH P-256 -> HKDF ->
AES-GCM, the email bound in), and the server opens it once. A challenge
lives two minutes and is used at most once, so a logged request is useless
and cannot be replayed; no long-term key exists for a later leak to expose.
(app/lib/auth/sealed.ts, app/lib/auth/sealClient.ts.)

Like the other sign-in tables, it answers to the system scope only
(20261102000000_sign_in_tables_system_only). Safe to apply twice.

**What it runs:**

- `create table if not exists public.signin_challenges ( id uuid primary key default gen_random_uuid(), private_key jsonb not null, created_at timestamptz not null default now(), expires_at timestamptz not null, used_at …`
- `create index if not exists signin_challenges_expires_idx on public.signin_challenges (expires_at)`
- `alter table public.signin_challenges enable row level security`
- `drop policy if exists app_access on public.signin_challenges`
- `create policy app_access on public.signin_challenges to cbt_app using (public.app_scope() = 'system') with check (public.app_scope() = 'system')`

---

## 15. `20261120000000_signin_challenges_delete_on_use.sql`

**No sign-in key outlives its one use**
Problem: a used challenge was only marked used (used_at); its private key
stayed in the row until an occasional clean-up. Anyone with a copy of the
database AND an old captured sign-in request could then open that request
and read the password (found 2026-11-19).

Change: a challenge is deleted in the same statement that hands its key
over (app/lib/repositories/accounts.ts takeChallenge), and expired ones go
whenever a new one is made. used_at is no longer needed. The rows left now
are dropped: a challenge lives two minutes, so anyone mid-sign-in simply
gets a fresh one. Safe to apply twice.

**What it runs:**

- `delete from public.signin_challenges`
- `alter table public.signin_challenges drop column if exists used_at`
