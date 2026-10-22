import { requireUser } from '@/app/lib/auth/session'
import QRCode from 'qrcode'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as bookingsRepo from '@/app/lib/repositories/bookings'
import { route } from '@/app/lib/http/handler'
import { onBehalf } from '@/app/lib/book/bookingActor'

// ── GET /api/book/[bookingId]/qr ─────────────────────────────────────────────
// The QR for a ticket, as a PNG data URI.
//
// Generated SERVER-SIDE and returned as a string, so the qrcode library never
// enters the browser bundle — it is a build-time dependency of one route rather
// than 20KB every traveller downloads to look at a page most of them will not
// scan.
//
// It encodes the PUBLIC ticket URL (/t/[token]), not the booking id and not the
// PNR as text. Scanning has to land somewhere useful on a phone that is not
// logged in; a QR that resolves to a string of characters is a QR nobody has a
// use for.
//
// Authenticated and ownership-checked like every other booking route: asking
// for someone else's QR is asking for their share link.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async (
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) => {
  const user = await requireUser()

  const { bookingId } = await params

  const booking = await bookingsRepo.shareInfo(db, bookingId)

  if (!booking) {
    return Response.json({ error: 'Booking not found' }, { status: 404 })
  }

  // The traveller, or someone who may book for them (app/lib/book/bookingActor.ts).
  if (booking.employee_id !== user.id && !(await onBehalf(db, user, booking.employee_id)).ok) {
    return Response.json({ error: 'Not authorized to view this booking' }, { status: 403 })
  }

  // No QR until a booking is ticketed — there is nothing to show at a gate
  // before then. The page simply renders none rather than an error.
  if (booking.status !== 'ticketed') {
    return Response.json({ ok: true, qr: null, url: null })
  }

  // Ticketed some other way than our ticket route, it has no token yet: made
  // now, once, rather than leaving the ticket without a QR.
  const token = booking.share_token
    ?? await bookingsRepo.ensureShareToken(db, bookingId, crypto.randomUUID().replace(/-/g, ''))
  if (!token) return Response.json({ ok: true, qr: null, url: null })

  const url = `${process.env.NEXT_PUBLIC_APP_URL}/t/${token}`

  try {
    const qr = await QRCode.toDataURL(url, {
      // Medium recovery: a ticket gets creased, screenshotted and photographed
      // off another screen. Higher levels make the code denser for a gain that
      // does not matter at this payload size.
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#0A0A14', light: '#FFFFFF' },
    })
    return Response.json({ ok: true, qr, url })
  } catch (err) {
    // A ticket without its QR is still a ticket. Fail soft rather than taking
    // the page down over a decorative-adjacent element.
    console.error('[qr] could not generate', err, { bookingId })
    return Response.json({ ok: true, qr: null, url })
  }
})
