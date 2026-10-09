import { AsyncLocalStorage } from 'node:async_hooks'

// ── Whose data this request may touch ────────────────────────────────────────
// Row-level security (db/migrations/20261012000000_tenant_policies.sql) asks
// the DATABASE to enforce tenant isolation, not only the code: every tenant
// table answers only rows of the tenant named in three session settings,
//   app.scope      'tenant' | 'system' | '' (nothing)
//   app.tmc_id     the TMC
//   app.client_id  the client, for a corporate user; empty for TMC staff
// and every query is run with them set (app/lib/db/index.ts).
//
// Where they come from: route() starts each request with NO scope, and
// signing in decides it (currentUser() in app/lib/auth/session):
//   TMC staff        tenant, their TMC, any of its clients
//   corporate user   tenant, their client (and its TMC's shared masters)
//   platform admin   system
// The few paths that run before anyone is known -- the session lookup, sign-in,
// password links, the public ticket link, the internal provisioning hook --
// say so explicitly with asSystem().
//
// A query with no scope sees no tenant rows at all. Forgetting to establish
// one fails closed: an empty answer, never another tenant's data.
// ─────────────────────────────────────────────────────────────────────────────

export type Scope = 'none' | 'tenant' | 'system'

export interface DbContext {
  scope: Scope
  tmcId: string | null
  clientId: string | null
}

const NOBODY: DbContext = { scope: 'none', tmcId: null, clientId: null }
const SYSTEM: DbContext = { scope: 'system', tmcId: null, clientId: null }

const storage = new AsyncLocalStorage<DbContext>()

// Outside any request (scripts, and the test suite's own setup queries) there
// is no store; this is what applies then. Production leaves it at "nothing".
let outside: DbContext = NOBODY

export function setOutsideContext(scope: 'none' | 'system'): void {
  outside = scope === 'system' ? SYSTEM : NOBODY
}

export function currentContext(): DbContext {
  return storage.getStore() ?? outside
}

// A fresh request: nothing until someone signs in.
export function runAsRequest<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ ...NOBODY }, fn)
}

// Work that must see across tenants, run before (or regardless of) who is
// signed in. Keep these few and obvious.
export function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ ...SYSTEM }, fn)
}

// Narrows the current request to a signed-in person's tenant. Changes the
// request's own context object, so it holds for the rest of the request.
// Outside a request there is nothing to narrow.
export function enterContext(next: DbContext): void {
  const store = storage.getStore()
  if (!store) return
  store.scope = next.scope
  store.tmcId = next.tmcId
  store.clientId = next.clientId
}

// The three settings, in order: app.scope, app.tmc_id, app.client_id.
export function contextValues(c: DbContext): string[] {
  return [c.scope === 'none' ? '' : c.scope, c.tmcId ?? '', c.clientId ?? '']
}

// One string per distinct context, so a pooled connection that already
// carries it is not told again.
export function contextKey(c: DbContext): string {
  return `${c.scope}|${c.tmcId ?? ''}|${c.clientId ?? ''}`
}
