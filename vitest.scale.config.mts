import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'

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

const devUrl = process.env.DATABASE_URL
if (!devUrl) throw new Error('npm run scale needs DATABASE_URL (in .env.local)')

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/scale/**/*.scale.ts'],
    globalSetup: ['./tests/scale/setup.ts'],
    setupFiles: ['./tests/setup/auth.ts', './tests/setup/mail.ts'],
    env: {
      DATABASE_URL: withDatabase(devUrl, 'cbt_scale'),
      TEST_ADMIN_DATABASE_URL: withDatabase(devUrl, 'postgres'),
    },
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
