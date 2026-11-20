// ── npm run release -- <label> ──────────────────────────────────────────────
// Builds a deployable package of the COMMITTED code: one folder (and a .zip)
// holding a self-contained Node server, its static files, the database
// migrations and the scripts that apply them. The target machine needs
// Node.js and nothing from npm (docs/deploy-windows.md).
//
//   NEXT_PUBLIC_APP_URL=https://cbt-uat.example.com npm run release -- uat
//
// NEXT_PUBLIC_APP_URL is required and fixed into the build (links in emails,
// the ticket QR), so a package is built for one environment's address.
//
// How: a temporary git worktree of HEAD (uncommitted changes are never
// shipped, and the running dev server's .next is never touched), `npm ci`
// there, `next build` (output: 'standalone'), then the package is assembled
// under publish/ (gitignored) and checked:
//   - no .env file or other secret travels in it;
//   - no symlink or junction (Windows stores absolute targets: the package
//     would not move to another machine);
//   - the packages the database scripts need (pg) are present.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const label = (process.argv[2] ?? 'uat').replace(/[^a-z0-9-]/gi, '')
const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')

function fail(message) { console.error(`\n[publish] ${message}\n`); process.exit(1) }
function run(cmd, args, cwd, env = {}) {
  console.log(`[publish] ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } })
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

if (!/^https:\/\//.test(appUrl)) {
  fail('Set NEXT_PUBLIC_APP_URL to the environment\'s HTTPS address, e.g. https://cbt-uat.example.com\n' +
    '          (sign-in needs HTTPS: the browser seals the password with Web Crypto, which exists only on secure pages).')
}

const sha = git('rev-parse', '--short', 'HEAD')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (git('status', '--porcelain')) console.warn('[publish] Uncommitted changes are NOT in the package: it is built from the last commit, ' + sha + '.')

const stamp = new Date().toISOString().slice(0, 10)
const name = `cbt-${label}-${stamp}-${sha}`
const outDir = join(root, 'publish', name)
const work = join(root, '..', `.cbt-publish-${sha}`)

rmSync(outDir, { recursive: true, force: true })
if (existsSync(work)) { try { git('worktree', 'remove', '--force', work) } catch { rmSync(work, { recursive: true, force: true }) } }

try {
  git('worktree', 'add', '--detach', work, 'HEAD')
  run('npm', ['ci', '--no-audit', '--no-fund'], work)
  run('npm', ['run', 'build'], work, { NEXT_PUBLIC_APP_URL: appUrl, NEXT_TELEMETRY_DISABLED: '1' })

  const standalone = join(work, '.next', 'standalone')
  if (!existsSync(join(standalone, 'server.js'))) fail('The build made no .next/standalone/server.js (is output: "standalone" set in next.config.ts?)')

  mkdirSync(outDir, { recursive: true })
  cpSync(standalone, outDir, { recursive: true })
  cpSync(join(work, '.next', 'static'), join(outDir, '.next', 'static'), { recursive: true })
  cpSync(join(work, 'public'), join(outDir, 'public'), { recursive: true })
  // The database side: migrations and the scripts that apply them.
  cpSync(join(work, 'db', 'migrations'), join(outDir, 'db', 'migrations'), { recursive: true, filter: src => !src.includes('archive') })
  cpSync(join(work, 'schema', 'baseline.sql'), join(outDir, 'schema', 'baseline.sql'))
  for (const s of ['migrate.mjs', 'create-app-login.mjs', 'create-database.mjs', 'pg-tools.mjs', 'escalate.mjs']) {
    cpSync(join(work, 'scripts', s), join(outDir, 'scripts', s))
  }
  cpSync(join(work, 'deploy'), join(outDir, 'deploy'), { recursive: true })
  cpSync(join(work, 'docs', 'deploy-windows.md'), join(outDir, 'DEPLOY.md'))

  // ── Checks ────────────────────────────────────────────────────────────────
  const problems = []
  ;(function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      const st = lstatSync(p)
      const rel = relative(outDir, p)
      if (st.isSymbolicLink()) problems.push(`a link (would not move to another machine): ${rel}`)
      else if (st.isDirectory()) walk(p)
      else if (/^\.env/.test(entry)) problems.push(`a secrets file travels in the package: ${rel}`)
    }
  })(outDir)
  if (!existsSync(join(outDir, 'node_modules', 'pg'))) problems.push('node_modules/pg is missing: the database scripts need it')
  if (problems.length) fail(`The package failed its checks:\n  - ${problems.join('\n  - ')}`)

  writeFileSync(join(outDir, 'VERSION.txt'), [
    `package   ${name}`, `commit    ${git('rev-parse', 'HEAD')} (${branch})`, `built     ${new Date().toISOString()}`,
    `for       ${appUrl}`, `node      ${process.version}`, '',
  ].join('\r\n'))

  // One file to copy to the server.
  const zip = `${outDir}.zip`
  rmSync(zip, { force: true })
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`], root)
  } else {
    run('zip', ['-qr', zip, '.'], outDir)
  }
  console.log(`\n[publish] Done.\n  folder  ${outDir}\n  zip     ${zip}\n  next    copy the zip to the server and follow DEPLOY.md inside it\n`)
} finally {
  try { git('worktree', 'remove', '--force', work) } catch { /* already gone */ }
}
