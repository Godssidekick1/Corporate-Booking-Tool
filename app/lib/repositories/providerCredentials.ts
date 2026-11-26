import { exec, maybeOne, sql, type Queryable } from '@/app/lib/db/sql'
import { onSystem } from '@/app/lib/db/systemScope'

// ── The flight provider's credentials (one row) ──────────────────────────────
// System scope only (RLS, 20261126000000_provider_credentials). The password
// arrives here already sealed (app/lib/crypto/secretBox.ts) and leaves sealed;
// opening it is the caller's job (app/lib/amadeus/credentials.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderCredentialsRow {
  base_url: string
  client_code: string
  username: string
  password_sealed: string
  updated_at: string
  updated_by_email: string | null
}

export async function current(db: Queryable): Promise<ProviderCredentialsRow | null> {
  return maybeOne<ProviderCredentialsRow>(onSystem(db), sql`
    select p.base_url, p.client_code, p.username, p.password_sealed, p.updated_at, a.email as updated_by_email
    from provider_credentials p
    left join accounts a on a.id = p.updated_by
    where p.id = 1`)
}

export async function save(db: Queryable, row: {
  baseUrl: string; clientCode: string; username: string; passwordSealed: string; updatedBy: string
}): Promise<void> {
  await exec(onSystem(db), sql`
    insert into provider_credentials (id, base_url, client_code, username, password_sealed, updated_by, updated_at)
    values (1, ${row.baseUrl}, ${row.clientCode}, ${row.username}, ${row.passwordSealed}, ${row.updatedBy}, now())
    on conflict (id) do update set
      base_url = excluded.base_url, client_code = excluded.client_code, username = excluded.username,
      password_sealed = excluded.password_sealed, updated_by = excluded.updated_by, updated_at = now()`)
}
