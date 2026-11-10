import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as refunds from '@/app/lib/repositories/refunds'
import { refundCaller } from '@/app/lib/refunds/access'
import { detectType, safeFilename, MAX_BYTES } from '@/app/lib/refunds/attachments'
import { route } from '@/app/lib/http/handler'
import { isUuid } from '@/app/lib/book/bookingActor'

// ── POST /api/tmc/queues/refunds/[id]/attachments ────────────────────────────
// Adds a document to a refund (the airline's refund note, an email…).
// multipart/form-data with one `file`: PDF, JPEG or PNG by its own bytes
// (app/lib/refunds/attachments.ts), at most 5 MB, at most 10 per refund.
// Allowed while pending and after processing (paperwork often arrives
// later), not on a rejected refund. TMC staff with process_refunds.
// ─────────────────────────────────────────────────────────────────────────────

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser()
  const caller = await refundCaller(db, user.id)
  if (!caller.ok) return Response.json({ error: caller.error }, { status: caller.status })

  const { id } = await params
  const d = isUuid(id) ? await refunds.detail(db, id, caller) : null
  if (!d) return Response.json({ error: 'Refund not found' }, { status: 404 })
  if (d.status === 'rejected') return Response.json({ error: 'This refund was rejected; nothing can be attached.' }, { status: 409 })

  const existing = await refunds.attachments(db, d.id)
  if (existing.length >= refunds.MAX_ATTACHMENTS) {
    return Response.json({ error: `A refund can have at most ${refunds.MAX_ATTACHMENTS} documents.` }, { status: 409 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!file || typeof file === 'string') return Response.json({ error: 'Choose a file to upload.' }, { status: 400 })
  if (file.size > MAX_BYTES) return Response.json({ error: 'The file is larger than 5 MB.' }, { status: 413 })
  if (file.size === 0) return Response.json({ error: 'The file is empty.' }, { status: 400 })

  const bytes = Buffer.from(await file.arrayBuffer())
  const type = detectType(bytes)
  if (!type) return Response.json({ error: 'Only PDF, JPG and PNG files can be attached.' }, { status: 415 })

  const saved = await refunds.addAttachment(db, d, { filename: safeFilename(file.name, type), contentType: type, bytes, by: user.id })
  return Response.json({ ok: true, attachment: saved })
})
