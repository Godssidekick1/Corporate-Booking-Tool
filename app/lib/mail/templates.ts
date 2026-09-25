import type { Mail } from './index'

// ── Email templates ──────────────────────────────────────────────────────────
// In the repository, reviewed like code. They used to live in the Supabase
// dashboard, where a wrong edit broke every invite with no diff to show for
// it (see the history of app/auth/callback).
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT = 'TravelDesk by Amadeus'

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function layout(heading: string, paragraphs: string[], action: { label: string; url: string }, footnote: string): string {
  return `<!doctype html><html><body style="margin:0;background:#F7F8FC;font-family:Arial,sans-serif;color:#0A0A14">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:8px;padding:32px">
<tr><td style="font-size:20px;font-weight:bold;padding-bottom:16px">${escape(heading)}</td></tr>
${paragraphs.map(p => `<tr><td style="font-size:14px;line-height:1.6;padding-bottom:12px">${escape(p)}</td></tr>`).join('\n')}
<tr><td style="padding:12px 0 20px"><a href="${escape(action.url)}" style="display:inline-block;background:#000835;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 20px;border-radius:6px">${escape(action.label)}</a></td></tr>
<tr><td style="font-size:12px;color:#6B7280;line-height:1.6">${escape(footnote)}<br>${escape(action.url)}</td></tr>
</table></td></tr></table></body></html>`
}

export function inviteEmail(to: string, link: string, days: number): Mail {
  const lines = [
    `You have been invited to ${PRODUCT}, your organisation's corporate travel tool.`,
    `Choose a password to finish setting up your account. This link works once and expires in ${days} days.`,
  ]
  const footnote = 'If you were not expecting this invitation you can ignore this email. The button not working? Paste this address into your browser:'
  return {
    to,
    subject: `You're invited to ${PRODUCT}`,
    text: `${lines.join('\n\n')}\n\nSet your password: ${link}\n`,
    html: layout('Set up your account', lines, { label: 'Set your password', url: link }, footnote),
  }
}

export function resetEmail(to: string, link: string, minutes: number): Mail {
  const lines = [
    `Someone asked to reset the password for this ${PRODUCT} account.`,
    `This link works once and expires in ${minutes} minutes. Setting a new password signs you out everywhere else.`,
  ]
  const footnote = 'If you did not ask for this, ignore this email: your password stays as it is. The button not working? Paste this address into your browser:'
  return {
    to,
    subject: `Reset your ${PRODUCT} password`,
    text: `${lines.join('\n\n')}\n\nReset your password: ${link}\n`,
    html: layout('Reset your password', lines, { label: 'Choose a new password', url: link }, footnote),
  }
}
