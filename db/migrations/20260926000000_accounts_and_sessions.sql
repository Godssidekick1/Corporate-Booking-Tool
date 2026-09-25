-- ============================================================================
-- The application's own identity: accounts, sessions, one-time tokens, and
-- sign-in throttling (Stage 3, phase 3)
--
-- Replaces Supabase's auth.users and GoTrue's JWT sessions.
--
-- ACCOUNTS
--   accounts.id is the id the rest of the schema already uses for a person:
--   employees.id and platform_admins.user_id were both minted by GoTrue as the
--   auth user's id. The next migration copies them here, so no business row
--   changes.
--
-- SESSIONS
--   Server-side and revocable. The browser holds a random 256-bit token; this
--   table holds only its SHA-256, so a read of this table (a backup, a leaked
--   dump) yields nothing that can be presented as a cookie. A session ends when
--   it is revoked, when it has been idle too long, or at its absolute expiry,
--   whichever comes first. The expiry times themselves live in
--   app/lib/auth/session.ts.
--
-- AUTH TOKENS
--   Invite and password-reset links. Stored hashed like sessions. Single use
--   (consumed_at), and short-lived.
--
-- AUTH ATTEMPTS
--   One row per throttled event (a failed sign-in, a reset request), keyed by
--   what is being limited: an email or an IP. Counted over a sliding window,
--   pruned as it goes. Kept in PostgreSQL, not Redis: the volume is tiny, and
--   one datastore is one thing to operate.
--
-- Row level security is enabled on all four tables with no policies, like
-- every other table here: nothing but the owner can read them. The password
-- hashes must never be reachable through Supabase's Data API while Supabase
-- hosts this database (see 20260925000000).
-- ============================================================================

create table public.accounts (
  id                   uuid primary key default gen_random_uuid(),
  -- Stored normalised, so equality is the whole comparison.
  email                text not null unique check (email = lower(btrim(email)) and email like '_%@_%'),
  -- argon2id for passwords set here; bcrypt for ones imported from Supabase,
  -- replaced with argon2id the next time the person signs in. Null until a
  -- password is chosen (an invite that has not been accepted).
  password_hash        text,
  -- Set when an admin chose the password. Server-owned: it used to live in
  -- user_metadata, which the user could clear on themselves.
  must_change_password boolean not null default false,
  email_verified_at    timestamptz,
  password_changed_at  timestamptz,
  last_sign_in_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table public.sessions (
  -- SHA-256 of the cookie's token, hex.
  id                  text primary key check (id ~ '^[0-9a-f]{64}$'),
  account_id          uuid not null references public.accounts (id) on delete cascade,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  idle_expires_at     timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at          timestamptz,
  revoked_reason      text,
  ip                  text,
  user_agent          text,
  check (idle_expires_at <= absolute_expires_at)
);

-- "Every live session of this account": revocation on password change,
-- password reset and deactivation.
create index sessions_live_by_account on public.sessions (account_id) where revoked_at is null;

create table public.auth_tokens (
  -- SHA-256 of the token in the link, hex.
  id          text primary key check (id ~ '^[0-9a-f]{64}$'),
  account_id  uuid not null references public.accounts (id) on delete cascade,
  purpose     text not null check (purpose in ('invite', 'reset')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  -- The admin who sent an invite, or null for a self-service reset.
  created_by  uuid references public.accounts (id) on delete set null
);

create index auth_tokens_open_by_account on public.auth_tokens (account_id, purpose) where consumed_at is null;

create table public.auth_attempts (
  id  bigint generated always as identity primary key,
  -- e.g. 'signin:email:a@b.c', 'signin:ip:203.0.113.9', 'reset:email:a@b.c'
  key text not null,
  at  timestamptz not null default now()
);

create index auth_attempts_by_key on public.auth_attempts (key, at);

alter table public.accounts enable row level security;
alter table public.sessions enable row level security;
alter table public.auth_tokens enable row level security;
alter table public.auth_attempts enable row level security;
