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
    include: ['app/lib/**/*.test.ts'],
    // The database tests share one PostgreSQL instance and write real rows.
    // Running files in parallel would let one file's cleanup delete another
    // file's fixtures mid-assertion.
    fileParallelism: false,
    // Surface slow tests rather than letting a hanging one look like a pass.
    testTimeout: 10_000,
  },
})
