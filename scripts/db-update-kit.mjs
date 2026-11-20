// ── npm run db:update-kit -- <since YYYY-MM-DD> ──────────────────────────────
// Everything a database restored from an older dump needs to catch up with
// the schema, for someone who runs it on their own machine:
//
//   npm run db:update-kit -- 2026-10-22
//
// Makes publish/db-update-since-<date>/ (and a .zip) holding:
//   db/migrations/     every migration (non-archive). migrate.mjs applies only
//                      those the database has not recorded, in order, one
//                      transaction each, and stops on any file changed after
//                      it was applied, so sending all of them is safe
//   scripts/migrate.mjs  the current runner
//   DB-CHANGES.md      for each migration ADDED since <date>: why it exists
//                      (its header) and the statements that change tables,
//                      columns, constraints, indexes, policies and data
//   README.md          back up, preview (--status), apply, check, roll back
//
// Not a hand-written SQL script on purpose: run through migrate.mjs, every
// file is recorded in schema_migrations, so nothing is applied twice and the
// next release's migrations follow on cleanly.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync, execSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const since = process.argv[2] ?? ''
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('\n[db-update-kit] Give the date of the dump the database came from: npm run db:update-kit -- 2026-10-22\n')
  process.exit(1)
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const dir = join(root, 'db', 'migrations')
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
// When each file entered the repository (its first commit).
const added = Object.fromEntries(files.map(f => [f, git('log', '--diff-filter=A', '--format=%as', '-1', '--', `db/migrations/${f}`)]))
const fresh = files.filter(f => added[f] >= since)
if (fresh.length === 0) { console.log(`[db-update-kit] Nothing added since ${since}.`); process.exit(0) }

// A migration's header: its opening comment block, without the rules.
function header(sql) {
  const lines = []
  for (const line of sql.split(/\r?\n/)) {
    if (!line.startsWith('--')) { if (lines.length) break; else continue }
    const text = line.replace(/^-- ?/, '')
    if (/^[─-]{10,}$/.test(text.trim())) continue
    lines.push(text.replace(/^── (.*?) ─*$/, '**$1**'))
  }
  return lines.join('\n').trim()
}

// The statements that change the schema or its data, each in full (where
// clauses included: "delete from x" alone would read as emptying the table).
// Function bodies and DO blocks ($$ … $$) are shown as such, with a pointer to
// the file, since their insides are not statements of their own.
const VERB = /^(create|alter|drop|comment|insert|update|delete|grant|revoke|do|truncate)\b/i
function changes(sql) {
  const body = sql.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, () => '$$…$$')
  return body.split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => VERB.test(s))
    .map(s => (/^do\b/i.test(s) ? 'DO $$…$$ (a block that loops over tables: see the file for what it does)' : s))
    .map(s => (s.length > 220 ? `${s.slice(0, 217)}…` : s))
}

const name = `db-update-since-${since}`
const out = join(root, 'publish', name)
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'db', 'migrations'), { recursive: true })
for (const f of files) cpSync(join(dir, f), join(out, 'db', 'migrations', f))
mkdirSync(join(out, 'scripts'), { recursive: true })
cpSync(join(root, 'scripts', 'migrate.mjs'), join(out, 'scripts', 'migrate.mjs'))

const commit = git('rev-parse', '--short', 'HEAD')
const md = [
  `# Database changes since ${since}`,
  '',
  `${fresh.length} migrations were added after ${since} (up to commit ${commit}). Each runs in its own`,
  'transaction through `scripts/migrate.mjs`, which records it in `schema_migrations`.',
  '`node scripts/migrate.mjs --status` on your database lists which of these it still needs.',
  '',
  '| # | Migration | Added |',
  '|---|---|---|',
  ...fresh.map((f, i) => `| ${i + 1} | \`${f}\` | ${added[f]} |`),
  '',
  ...fresh.flatMap((f, i) => {
    const sql = readFileSync(join(dir, f), 'utf8')
    const list = changes(sql)
    return [
      '---', '', `## ${i + 1}. \`${f}\``, '', header(sql), '',
      '**What it runs:**', '',
      ...(list.length ? list.map(s => `- \`${s.replace(/`/g, "'")}\``) : ['- (a DO block or function: see the file)']),
      '',
    ]
  }),
].join('\n')
writeFileSync(join(out, 'DB-CHANGES.md'), md)

writeFileSync(join(out, 'README.md'), [
  `# Bring a database up to date (dump of ${since} or later)`,
  '',
  'Run on a machine that can reach the database, with Node.js and the project\'s `node_modules` (for `pg`).',
  '',
  '1. **Back up first.**',
  '   ```powershell',
  '   pg_dump -U postgres -Fc -d cbt -f cbt-before-update.dump',
  '   ```',
  '2. **Copy the kit into the project:** replace `db\\migrations\\` with the kit\'s folder, and',
  '   `scripts\\migrate.mjs` with the kit\'s (it is newer: one TLS rule, and `?sslmode=disable` as an',
  '   explicit way to turn TLS off).',
  '3. **Point it at the database** as the OWNER: `MIGRATE_DATABASE_URL` in `.env.local`, or',
  '   `$env:MIGRATE_DATABASE_URL = "postgresql://owner:password@host:5432/cbt"`.',
  '4. **Preview** (changes nothing):',
  '   ```powershell',
  '   node scripts\\migrate.mjs --status',
  '   ```',
  '   It lists what is applied and what is pending. `DB-CHANGES.md` explains each pending one.',
  '5. **Apply:**',
  '   ```powershell',
  '   node scripts\\migrate.mjs',
  '   ```',
  '   One transaction per file: a failure leaves that file unapplied and stops. Fix the cause and',
  '   run it again; it carries on from there.',
  '6. **Check:** `node scripts\\migrate.mjs --status` again shows nothing pending.',
  '',
  '**If something goes wrong:** restore the backup from step 1 (`pg_restore -U postgres -d cbt --clean cbt-before-update.dump`).',
  '',
  'These changes go with the application of the same commit: deploy that version of the app after applying them.',
  '',
].join('\n'))

const zip = `${out}.zip`
rmSync(zip, { force: true })
execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}'"`, { stdio: 'inherit' })
console.log(`\n[db-update-kit] ${fresh.length} migrations since ${since}.\n  folder  ${out}\n  zip     ${zip}\n`)
