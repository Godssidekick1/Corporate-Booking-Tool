// ── PostgreSQL command-line tools ───────────────────────────────────────────
// pg_dump and psql, for scripts/capture-baseline.mjs and create-database.mjs.
// Found on PATH, else in the newest C:\Program Files\PostgreSQL\<n>\bin (the
// Windows installer does not add itself to PATH). The password goes in
// PGPASSWORD for the child process only, never on its command line, where
// other users of the machine could read it.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function pgTool(name) {
  const onPath = spawnSync(name, ['--version'], { encoding: 'utf8' })
  if (onPath.status === 0) return name
  const root = 'C:\\Program Files\\PostgreSQL'
  if (existsSync(root)) {
    const versions = readdirSync(root).filter(v => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a))
    for (const v of versions) {
      const exe = join(root, v, 'bin', `${name}.exe`)
      if (existsSync(exe)) return exe
    }
  }
  throw new Error(`${name} not found: install the PostgreSQL client tools, or add their bin folder to PATH.`)
}

// Connection arguments and environment for a tool, from a connection URL.
export function connectionFor(url, database) {
  const u = new URL(url)
  const args = ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', database ?? u.pathname.slice(1)]
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }
  const sslmode = u.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  return { args, env }
}
