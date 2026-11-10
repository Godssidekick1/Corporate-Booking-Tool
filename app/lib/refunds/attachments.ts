// ── Refund attachments: what a file really is ───────────────────────────────
// The browser's word for a file's type is whatever the uploader's machine
// says, so the file's own first bytes decide: PDF, JPEG and PNG each start
// with a fixed signature. Anything else is refused, whatever its name or
// claimed type. Kept in the database (refund_attachments, at most 5 MB).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_BYTES = 5 * 1024 * 1024

export type AttachmentType = 'application/pdf' | 'image/jpeg' | 'image/png'

export function detectType(bytes: Uint8Array): AttachmentType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'          // %PDF-
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  return null
}

// A name safe to store and to send back in Content-Disposition: no path, no
// quotes or control characters, at most 200 characters, never empty.
export function safeFilename(raw: string | null | undefined, type: AttachmentType): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\x00-\x1f\x7f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (cleaned) return cleaned
  return type === 'application/pdf' ? 'document.pdf' : type === 'image/png' ? 'image.png' : 'image.jpg'
}
