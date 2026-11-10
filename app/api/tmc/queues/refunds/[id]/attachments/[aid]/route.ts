import { NextRequest } from 'next/server'
import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import * as refunds from '@/app/lib/repositories/refunds'
import { refundCaller } from '@/app/lib/refunds/access'
import { route } from '@/app/lib/http/handler'
import { isUuid } from '@/app/lib/book/bookingActor'

// ── GET / DELETE /api/tmc/queues/refunds/[id]/attachments/[aid] ──────────────
// GET downloads the document, always as a download (never shown inline, so
// a file cannot run as a page here), never cached. DELETE removes one while
// the refund is pending; a processed refund's paperwork stays with it.
// TMC staff with process_refunds, within their reach.
// ─────────────────────────────────────────────────────────────────────────────

async function load(id: string, aid: string, userId: string) {
  const caller = await refundCaller(db, userId)
  if (!caller.ok) return { error: Response.json({ error: caller.error }, { status: caller.status }) }
  const d = isUuid(id) && isUuid(aid) ? await refunds.detail(db, id, caller) : null
  if (!d) return { error: Response.json({ error: 'Not found' }, { status: 404 }) }
  return { d }
}

export const GET = route(async (_req: NextRequest, { params }: { params: Promise<{ id: string; aid: string }> }) => {
  const user = await requireUser()
  const { id, aid } = await params
  const r = await load(id, aid, user.id)
  if (r.error) return r.error

  const file = await refunds.attachmentFile(db, r.d.id, aid)
  if (!file) return Response.json({ error: 'Not found' }, { status: 404 })
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'content-type': file.content_type,
      'content-disposition': `attachment; filename="${file.filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'cache-control': 'private, no-store',
    },
  })
})

export const DELETE = route(async (_req: NextRequest, { params }: { params: Promise<{ id: string; aid: string }> }) => {
  const user = await requireUser()
  const { id, aid } = await params
  const r = await load(id, aid, user.id)
  if (r.error) return r.error
  if (r.d.status !== 'pending') {
    return Response.json({ error: 'Documents stay with a refund once it is settled.' }, { status: 409 })
  }
  if (!(await refunds.removeAttachment(db, r.d.id, aid))) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json({ ok: true })
})
