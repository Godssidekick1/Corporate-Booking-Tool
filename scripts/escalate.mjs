// ── escalate.mjs ─────────────────────────────────────────────────────────────
// Asks the running app to pass every approval that has waited past its
// company's limit to the approver's manager (POST /api/internal/escalate).
// For a scheduler: Windows Task Scheduler or cron, every 15 minutes or so.
//
//   npm run escalate                    (NEXT_PUBLIC_APP_URL, INTERNAL_API_SECRET)
//   node scripts/escalate.mjs <app url>
//
// The secret is read from the environment or .env.local and sent as a header,
// never printed.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function envValue(name) {
  if (process.env[name]) return process.env[name]
  const envPath = join(process.cwd(), '.env.local')
  if (!existsSync(envPath)) return undefined
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`))
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

const appUrl = (process.argv[2] ?? envValue('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, '')
const secret = envValue('INTERNAL_API_SECRET')
if (!secret) {
  console.error('INTERNAL_API_SECRET is not set (environment or .env.local).')
  process.exit(1)
}

const res = await fetch(`${appUrl}/api/internal/escalate`, { method: 'POST', headers: { 'x-internal-secret': secret } })
const body = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`escalate: ${res.status} ${body.error ?? ''}`.trim())
  process.exit(1)
}
console.log(`escalate: ${body.escalated} passed to a manager, ${body.kept} kept (no manager to pass to)`)
