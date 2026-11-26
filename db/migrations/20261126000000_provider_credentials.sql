-- ── The flight provider's credentials, in the database ──────────────────────
-- Problem: the Amadeus API's base URL, client code, user name and password
-- lived in .env.local / the server environment. The user was asked to keep
-- them in a table instead (2026-11-26): they can then be set and rotated from
-- the platform console, by a platform admin, without editing files on the
-- server or redeploying.
--
-- Change: one row (the platform has one provider account). The password is
-- stored ENCRYPTED (AES-256-GCM, app/lib/crypto/secretBox.ts) with a key that
-- is not in the database: PROVIDER_CREDENTIALS_KEY in the server environment.
-- A database dump or backup therefore does not hold a usable password. The
-- password is write-only: no API returns it, decrypted or not.
--
-- Like the sign-in tables, the row answers to the system scope only
-- (20261102000000_sign_in_tables_system_only): no tenant request can read it.
-- Safe to apply twice.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.provider_credentials (
  -- One set for the platform.
  id smallint primary key default 1 check (id = 1),
  provider text not null default 'amadeus' check (provider = 'amadeus'),
  base_url text not null check (base_url ~ '^https?://[^ ]+$'),
  client_code text not null check (length(client_code) between 1 and 64),
  username text not null check (length(username) between 1 and 128),
  -- "v1.<key id>.<base64 of iv | ciphertext | tag>"; the key id says which
  -- PROVIDER_CREDENTIALS_KEY sealed it, so a wrong key is reported as such.
  password_sealed text not null,
  updated_by uuid references public.accounts(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Every foreign key has an index (tests/schema.test.ts).
create index if not exists provider_credentials_updated_by_fk_idx on public.provider_credentials (updated_by);

alter table public.provider_credentials enable row level security;
drop policy if exists app_access on public.provider_credentials;
create policy app_access on public.provider_credentials to cbt_app
  using (public.app_scope() = 'system')
  with check (public.app_scope() = 'system');

comment on table public.provider_credentials is
  'The flight provider account (one row). password_sealed is AES-256-GCM, key PROVIDER_CREDENTIALS_KEY (not stored here).';
