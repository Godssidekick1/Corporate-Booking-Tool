import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createDbClient } from '@/app/lib/db/client'
import { createDualRunClient } from '@/app/lib/db/dualRun'
import type { QueryBuilder } from '@/app/lib/db/builder'

// ── The swap point ───────────────────────────────────────────────────────────
// Every one of the 537 data call sites in this codebase reaches PostgreSQL
// through this function, so this is the only file that has to change to move
// the application off PostgREST.
//
// DATA goes to PostgreSQL directly, through the shim in app/lib/db.
// AUTH stays on Supabase GoTrue, unchanged, this stage.
//
// That split is deliberate. The reason to leave PostgREST is that it gives one
// statement per HTTP call, so the 36 routes here that issue several writes
// cannot be atomic -- a failure halfway leaves rows no invariant describes.
// Authentication has no such problem: it is a handful of admin calls
// (createUser, deleteUser, inviteUserByEmail, resetPasswordForEmail) with no
// multi-step invariant, and self-hosting GoTrue is a separate project with its
// own migration risk. Moving both at once would make a bad week.
//
// DB_DRIVER:
//   pg        (default) data through the shim
//   postgrest             data through Supabase, as before -- the rollback
//
// DB_DUAL_RUN=1 runs READS through both and logs where they disagree. See
// app/lib/db/dualRun.ts.
// ─────────────────────────────────────────────────────────────────────────────

// The compatibility surface. `from` is typed with an `any` default rather than
// `unknown` because that is precisely what the call sites were written against:
// this project passes no generated Database type to createClient, so supabase-js
// has always returned `any` rows here. Tightening it is worthwhile and is a
// change to 537 call sites, not to this one.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ServiceClient {
  // `any[]`, not `any`. The distinction matters: with `any[]` a `.map(b => …)`
  // callback is CONTEXTUALLY typed as any and compiles, whereas with a bare
  // `any` there is no contextual type at all and every such callback trips
  // noImplicitAny. `any[]` is also what supabase-js resolves to here.
  from<T = any[]>(table: string): QueryBuilder<T>
  auth: SupabaseClient['auth']
}

function createSupabaseClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}

export function createServiceClient(): ServiceClient {
  const supabase = createSupabaseClient()

  // The rollback path: data goes back over HTTP to PostgREST. Cast because
  // supabase-js's builder is structurally compatible with what the call sites
  // use but is not the shim's declared type. Temporary by design -- this
  // branch and the flag are deleted once the team's QA pass is clean.
  if (process.env.DB_DRIVER === 'postgrest') {
    return supabase as unknown as ServiceClient
  }

  const pg = createDbClient()

  const data = process.env.DB_DUAL_RUN === '1'
    ? createDualRunClient(pg, supabase)
    : pg

  return {
    from: data.from.bind(data),
    // Not proxied, not reimplemented. GoTrue owns users this stage.
    auth: supabase.auth,
  } as ServiceClient
}
