import { vi, beforeEach } from 'vitest'
import { resetOutbox } from '../harness/mail'

// Outgoing email, faked for EVERY test file: an invite or reset in a test must
// never reach a real address. Tests inspect tests/harness/mail's outbox.
vi.mock('@/app/lib/mail', async () => {
  const { fakeSendMail } = await import('../harness/mail')
  class MailNotConfigured extends Error {}
  return { sendMail: fakeSendMail, MailNotConfigured, mailMode: () => 'log' as const }
})

beforeEach(() => resetOutbox())
