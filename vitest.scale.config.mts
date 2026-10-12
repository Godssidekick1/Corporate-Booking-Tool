import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

// ── npm run scale ────────────────────────────────────────────────────────────
// Seeds a large TMC into a throwaway cbt_scale database and times the heavy
// endpoints and the booking-time lookups (tests/scale). Separate from the
// normal suite: it takes longer, and it measures rather than asserts.
//
//   npm run scale                       10k clients, 50k deal-code assignments…
//   SCALE_CLIENTS=50000 npm run scale   any size from tests/scale/seed.ts
// ─────────────────────────────────────────────────────────────────────────────

const envPath = fileURLToPath(new URL('./.env.local', import.meta.url))
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!match || process.env[match[1]] !== undefined) continue
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

// The owner (it creates cbt_scale and seeds it): MIGRATE_DATABASE_URL once the
// app itself runs as a restricted login.
const devUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL
if (!devUrl) throw new Error('npm run scale needs DATABASE_URL (in .env.local)')

// Measured AS THE APP RUNS: through the restricted login, so every timing
// includes the row-level-security policies (tests/setup/database.ts does the
// same for the suite). The owner only seeds -- it runs ANALYZE, which the app
// role may not.
const appPassword = randomBytes(18).toString('base64url')
process.env.TEST_APP_PASSWORD = appPassword
function asAppRole(url: string): string {
  const u = new URL(url)
  u.username = 'cbt_app_test'
  u.password = appPassword
  return u.toString()
}

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/scale/**/*.scale.ts'],
    globalSetup: ['./tests/scale/setup.ts'],
    setupFiles: ['./tests/setup/auth.ts', './tests/setup/mail.ts', './tests/setup/dbContext.ts'],
    env: {
      DATABASE_URL: asAppRole(withDatabase(devUrl, 'cbt_scale')),
      SCALE_OWNER_URL: withDatabase(devUrl, 'cbt_scale'),
      TEST_ADMIN_DATABASE_URL: withDatabase(devUrl, 'postgres'),
    },
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
