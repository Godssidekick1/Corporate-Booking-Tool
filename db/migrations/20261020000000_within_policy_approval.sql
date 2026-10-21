-- ── Corporate settings: whether a within-policy booking goes for approval ────
-- Problem: a company could not say "send every booking for approval". A
-- within-policy (green) booking reached an approver only when its chain had a
-- step set to fire on green, a TMC master shared across clients, not a
-- company's own choice.
--
-- Change: clients.within_policy_approval
--   * 'auto'      a within-policy booking is approved straight away (the
--                 default, as for every chain whose steps start at amber);
--   * 'required'  it goes to the traveller's approval chain like any other.
-- A booking that needs approval (within a fare cap's grace) or is out of policy
-- always goes for approval, whatever this says.
--
-- Backfill: a client reached by any air chain with a step that fires on green
-- (by a client default, band or employee assignment) starts as 'required', so
-- the same bookings reach the same approvers on the day this ships.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'within_policy_approval'
  ) then
    alter table public.clients add column within_policy_approval text not null default 'auto';

    update public.clients c set within_policy_approval = 'required'
    where exists (
      select 1
      from public.approval_chain_templates t
      where exists (select 1 from jsonb_array_elements(t.tiers) s where s->>'min_verdict' = 'green')
        and (
          exists (select 1 from public.client_default_approval_templates d
                  where d.client_id = c.id and d.category = 'air' and d.template_id = t.id)
          or exists (select 1 from public.band_approval_templates b
                     where b.client_id = c.id and b.category = 'air' and b.template_id = t.id)
          or exists (select 1 from public.employee_approval_templates e
                     join public.employees p on p.id = e.employee_id
                     where p.client_id = c.id and e.category = 'air' and e.template_id = t.id)
        )
    );
  end if;
end $$;

alter table public.clients drop constraint if exists clients_within_policy_approval_check;
alter table public.clients add constraint clients_within_policy_approval_check
  check (within_policy_approval in ('auto', 'required'));
