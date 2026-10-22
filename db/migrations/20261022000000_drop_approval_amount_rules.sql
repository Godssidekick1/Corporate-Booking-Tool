-- ── The old approval amounts, removed from stored policies ───────────────────
-- Problem: "Auto-approve under" and "Finance approval over" left the policy
-- editor and the verdict on 2026-10-20 (a spend question for expense
-- management, not a flight's policy), but their rows stayed in the stored
-- versions, read by nothing and shown by nothing, until a group was saved again.
--
-- Change: those rows are deleted, in every version. Nothing reads them, so no
-- verdict, approval or screen changes.
--
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

delete from public.policy_rules
where travel_type = 'approval' or limit_key in ('auto_approve_under', 'finance_approval_over');
