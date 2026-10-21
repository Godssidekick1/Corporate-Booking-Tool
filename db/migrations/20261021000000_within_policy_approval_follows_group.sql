-- ── Within-policy approval: the company's setting, or else the policy group ──
-- Problem: whether a within-policy booking goes for approval was a company
-- setting only, always set ('auto' by default). A policy group shared by
-- several companies could not say it for its bands.
--
-- Change: clients.within_policy_approval may be NULL, meaning "follow the
-- policy group". The order is:
--   1. the company's setting, when it has one ('auto' or 'required');
--   2. otherwise the traveller's policy group (rule within_policy_approval:
--      0 approved automatically, 1 sent for approval);
--   3. otherwise approved automatically, as before.
-- Every 'auto' becomes NULL: it was the default nobody chose, and with no
-- group rule yet it means the same thing. 'required', set by the backfill in
-- 20261020000000 from chains that already acted on every booking, stays.
--
-- The DDL is safe to apply twice; the runner applies the update once.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.clients alter column within_policy_approval drop not null;
alter table public.clients alter column within_policy_approval drop default;
update public.clients set within_policy_approval = null where within_policy_approval = 'auto';

alter table public.clients drop constraint if exists clients_within_policy_approval_check;
alter table public.clients add constraint clients_within_policy_approval_check
  check (within_policy_approval is null or within_policy_approval in ('auto', 'required'));
