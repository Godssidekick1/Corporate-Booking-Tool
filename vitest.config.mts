import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

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
    // Surface slow tests rather than letting a hanging one look like a pass.
    testTimeout: 10_000,
  },
})
