import type { Mail } from '@/app/lib/mail'

// ── A fake outbox ────────────────────────────────────────────────────────────
// tests/setup/mail.ts replaces app/lib/mail with this for every test file:
// nothing a test does may send a real email. Tests read `outbox` to see what
// would have gone out, and linkIn() to follow the link in it.
// ─────────────────────────────────────────────────────────────────────────────

export const outbox: Mail[] = []
let failNext: string | null = null

// Makes the next send fail, as an SMTP server refusing it would.
export function failNextMailWith(message: string): void {
  failNext = message
}

export function resetOutbox(): void {
  outbox.length = 0
  failNext = null
}

export async function fakeSendMail(mail: Mail): Promise<void> {
  if (failNext) {
    const message = failNext
    failNext = null
    throw new Error(message)
  }
  outbox.push(mail)
}

// The token and purpose from the invite/reset link in a message, as the
// confirm page reads them from the fragment.
export function linkIn(mail: Mail): { token: string; type: string; url: string } {
  const url = mail.text.match(/https?:\/\/\S+/)?.[0]
  if (!url) throw new Error(`[tests] no link in mail to ${mail.to}`)
  const params = new URLSearchParams(new URL(url).hash.slice(1))
  return { token: params.get('token') ?? '', type: params.get('type') ?? '', url }
}

export function lastMailTo(address: string): Mail | undefined {
  return [...outbox].reverse().find(m => m.to === address)
}
