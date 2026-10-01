import type { Transporter } from 'nodemailer'

// ── Outgoing email ───────────────────────────────────────────────────────────
// One function, sendMail(), and a transport chosen by configuration:
//
//   MAIL_TRANSPORT=smtp   SMTP_URL (smtp[s]://user:pass@host:port) and
//                         MAIL_FROM. For Microsoft 365, an internal relay,
//                         anything that speaks SMTP.
//   MAIL_TRANSPORT=log    Printed to the server log instead of sent.
//                         Development only: the log then holds live invite
//                         and reset links.
//
// Default: smtp when SMTP_URL is set, log in development, and in production
// nothing -- sendMail throws. An invite that silently goes nowhere is worse
// than one that fails with a message saying email is not configured.
//
// Tests replace this module (tests/setup/mail.ts), so no test sends anything.
// ─────────────────────────────────────────────────────────────────────────────

export interface Mail {
  to: string
  subject: string
  text: string
  html: string
}

export class MailNotConfigured extends Error {
  constructor(detail: string) {
    super(`[mail] email is not configured: ${detail}`)
    this.name = 'MailNotConfigured'
  }
}

export type MailMode = 'smtp' | 'log' | 'none'

// Which transport sendMail() would use. Exported for /api/health.
export function mailMode(): MailMode {
  const explicit = process.env.MAIL_TRANSPORT
  if (explicit === 'smtp' || explicit === 'log') return explicit
  if (process.env.SMTP_URL) return 'smtp'
  return process.env.NODE_ENV === 'production' ? 'none' : 'log'
}

let transporter: Promise<Transporter> | null = null

async function smtp(): Promise<Transporter> {
  const url = process.env.SMTP_URL
  if (!url) throw new MailNotConfigured('MAIL_TRANSPORT=smtp needs SMTP_URL')
  // Imported on first use, so a deployment that never sends mail never loads it.
  transporter ??= import('nodemailer').then(m => m.createTransport(url))
  return transporter
}

export async function sendMail(mail: Mail): Promise<void> {
  const m = mailMode()
  if (m === 'none') {
    throw new MailNotConfigured('set SMTP_URL and MAIL_FROM (or MAIL_TRANSPORT=log outside production)')
  }
  if (m === 'log') {
    console.info(`[mail] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`)
    return
  }
  const from = process.env.MAIL_FROM
  if (!from) throw new MailNotConfigured('MAIL_FROM is not set')
  await (await smtp()).sendMail({ from, ...mail })
}
