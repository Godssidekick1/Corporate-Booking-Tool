-- ── One-time keys for a sealed password ──────────────────────────────────────
-- Problem: the sign-in request carried the password as plain text inside
-- HTTPS. Anything that logs request bodies after TLS ends (a corporate proxy
-- that inspects HTTPS, a saved network capture, a debugging tool) would hold
-- it, and could replay it (user, 2026-11-19; PCI DSS 8.3.2).
--
-- Change: before signing in, the browser asks for a challenge. The server
-- makes a one-off ECDH key pair, keeps the private half here, and returns the
-- public half. The browser seals the password to it (ECDH P-256 -> HKDF ->
-- AES-GCM, the email bound in), and the server opens it once. A challenge
-- lives two minutes and is used at most once, so a logged request is useless
-- and cannot be replayed; no long-term key exists for a later leak to expose.
-- (app/lib/auth/sealed.ts, app/lib/auth/sealClient.ts.)
--
-- Like the other sign-in tables, it answers to the system scope only
-- (20261102000000_sign_in_tables_system_only). Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.signin_challenges (
  id uuid primary key default gen_random_uuid(),
  -- The private half, as a JWK. Never leaves the server.
  private_key jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists signin_challenges_expires_idx on public.signin_challenges (expires_at);

alter table public.signin_challenges enable row level security;
drop policy if exists app_access on public.signin_challenges;
create policy app_access on public.signin_challenges to cbt_app
  using (public.app_scope() = 'system')
  with check (public.app_scope() = 'system');
