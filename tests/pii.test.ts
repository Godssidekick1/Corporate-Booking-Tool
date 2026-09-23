import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// ── No personal data in committed snapshots ──────────────────────────────────
// Route tests snapshot real responses and the snapshot files are committed.
// The test database is anonymised (scripts/make-test-template.mjs), so this
// should never fire -- it exists for the day someone points a test at cbt_local
// or adds a column the scrubber does not know about.
//
// Deliberately blunt pattern checks rather than a clever classifier: a false
// alarm costs a look; a miss costs a passport number in git history.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()

function* snapshots(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* snapshots(path)
    else if (name.endsWith('.snap')) yield path
  }
}

const CHECKS: { what: string; pattern: RegExp; allowed: (match: string) => boolean }[] = [
  {
    what: 'email address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    allowed: m => m.endsWith('@example.test'),
  },
  {
    what: 'Indian mobile number',
    pattern: /(?<!\d)[6-9]\d{9}(?!\d)/g,
    allowed: m => m === '9999999999',
  },
  {
    what: 'passport number',
    pattern: /"passport(?:Number|No)?"\s*:\s*"([^"]*)"/gi,
    allowed: m => /X0000000|•/.test(m),
  },
]

describe('committed snapshots', () => {
  it('contain no personal data', () => {
    const findings: string[] = []
    for (const root of ['tests', 'app']) {
      for (const file of snapshots(join(ROOT, root))) {
        const text = readFileSync(file, 'utf8')
        for (const check of CHECKS) {
          for (const match of text.match(check.pattern) ?? []) {
            if (!check.allowed(match)) findings.push(`${relative(ROOT, file)}: ${check.what} "${match}"`)
          }
        }
      }
    }
    expect(findings, findings.join('\n')).toEqual([])
  })
})
