-- ============================================================================
-- audit_log: the actor is an account, and entries outlive what they describe
--
-- 1. user_id referenced employees(id). The actor of an authentication event is
--    an ACCOUNT, and some accounts have no employees row: platform admins by
--    design, and an admin-created account for the moment before its employee
--    row is written. Their sign-ins could not be recorded. Re-pointed at
--    accounts. A deleted account leaves its entries with user_id null, as a
--    deleted employee did.
--
-- 2. client_id and tmc_id were ON DELETE CASCADE, so deleting a client or a TMC
--    silently deleted its audit trail with it. An audit log that its own
--    subject's deletion erases is not one. Now ON DELETE SET NULL.
-- ============================================================================

alter table public.audit_log drop constraint if exists audit_log_user_id_fkey;

update public.audit_log l
   set user_id = null
 where l.user_id is not null
   and not exists (select 1 from public.accounts a where a.id = l.user_id);

alter table public.audit_log
  add constraint audit_log_user_id_fkey
  foreign key (user_id) references public.accounts (id) on delete set null;

alter table public.audit_log drop constraint if exists audit_log_company_id_fkey;
alter table public.audit_log
  add constraint audit_log_client_id_fkey
  foreign key (client_id) references public.clients (id) on delete set null;

alter table public.audit_log drop constraint if exists audit_log_tmc_id_fkey;
alter table public.audit_log
  add constraint audit_log_tmc_id_fkey
  foreign key (tmc_id) references public.tmcs (id) on delete set null;
