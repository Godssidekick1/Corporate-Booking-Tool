import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'

// ── .env.local ───────────────────────────────────────────────────────────────
// Next.js loads this automatically; Vitest does not, and Vite's own env
// handling only exposes VITE_-prefixed values to client code. The database
// tests read process.env.DATABASE_URL directly, so it has to be put there.
//
// Parsed rather than pulled in via dotenv: it is fifteen lines of KEY=value and
// a dependency for that is not worth it. Existing values win, so a variable set
// on the command line still overrides the file.
const envPath = fileURLToPath(new URL('./.env.local', import.meta.url))
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!match) continue
    const [, key, raw] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = raw.replace(/^["']|["']$/g, '')
  }
}

// ── The test database ────────────────────────────────────────────────────────
// Tests never touch cbt_local. Every run clones a fresh cbt_test from
// cbt_template -- an anonymised copy of cbt_local built by
// scripts/make-test-template.mjs -- so tests can write freely, start from
// identical data every time, and cannot put a real passport number into a
// committed snapshot.
//
// Derived from DATABASE_URL by swapping the database name, so the same host and
// credentials serve both.
function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

const devUrl = process.env.DATABASE_URL
const testUrl = devUrl ? withDatabase(devUrl, 'cbt_test') : undefined
const adminUrl = devUrl ? withDatabase(devUrl, 'postgres') : undefined

// ── Vitest ───────────────────────────────────────────────────────────────────
// The safety net for the PostgreSQL migration. 562 PostgREST call sites are
// about to be rewritten underneath this application; without tests that is an
// unverifiable refactor, and with them it is a mechanical one.
//
// SCOPE IS DELIBERATELY NARROW. These tests cover app/lib/ -- the domain layer
// -- and nothing else. That layer is where the money and access decisions are
// made, a good share of it is pure functions taking data and returning a
// verdict, and none of it touches a database. It is therefore both the most
// valuable thing to protect and the cheapest thing to test.
//
// Route handlers, React components and the Amadeus client are NOT covered here.
// Routes need a database and a session; components need a DOM; the provider
// client needs the provider. All three are worth testing eventually and none of
// them is a precondition for the migration.
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` -> `./*` mapping in tsconfig.json. Without it every
      // `@/app/lib/...` import in the codebase fails to resolve under Vitest,
      // because Vite does not read tsconfig paths on its own.
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    // Node, not jsdom: nothing under test touches the DOM, and jsdom would add
    // startup cost to every run for no benefit.
    environment: 'node',
    // app/lib: domain and data-layer tests. tests/: route characterisation
    // tests, which call route handlers directly -- see tests/harness.
    include: ['app/lib/**/*.test.ts', 'tests/**/*.test.ts'],
    // Recreates cbt_test from cbt_template once per run. Skipped when there is
    // no DATABASE_URL, in which case database tests skip themselves.
    globalSetup: testUrl ? ['./tests/setup/database.ts'] : [],
    // Replaces Supabase auth with a controllable fake for every test file.
    // Route handlers authenticate through utils/supabase/server, and 77 of 86
    // do nothing else with Supabase; mocking that one module is what lets a
    // test call a handler directly, as any user, with no login.
    setupFiles: ['./tests/setup/auth.ts'],
    env: testUrl && adminUrl
      ? { DATABASE_URL: testUrl, TEST_DATABASE_URL: testUrl, TEST_ADMIN_DATABASE_URL: adminUrl }
      : {},
    // The database tests share one PostgreSQL instance and write real rows.
    // Running files in parallel would let one file's cleanup delete another
    // file's fixtures mid-assertion.
    fileParallelism: false,
    // Surface slow tests rather than letting a hanging one look like a pass.
    testTimeout: 10_000,
  },
})
