-- ── No sign-in key outlives its one use ──────────────────────────────────────
-- Problem: a used challenge was only marked used (used_at); its private key
-- stayed in the row until an occasional clean-up. Anyone with a copy of the
-- database AND an old captured sign-in request could then open that request
-- and read the password (found 2026-11-19).
--
-- Change: a challenge is deleted in the same statement that hands its key
-- over (app/lib/repositories/accounts.ts takeChallenge), and expired ones go
-- whenever a new one is made. used_at is no longer needed. The rows left now
-- are dropped: a challenge lives two minutes, so anyone mid-sign-in simply
-- gets a fresh one. Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

delete from public.signin_challenges;

alter table public.signin_challenges drop column if exists used_at;
