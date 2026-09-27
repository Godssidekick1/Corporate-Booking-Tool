import type { NextRequest } from 'next/server'
import { Unauthenticated } from '@/app/lib/auth/session'

// ── route() ──────────────────────────────────────────────────────────────────
// NOTE THE FILENAME. This lives in app/, where Next treats any file called
// route.ts as a route handler; named route.ts it registered /lib/http as an
// endpoint and failed the build's type check. Never name a helper here
// route.ts, page.tsx or layout.tsx.
//
// Every API handler is wrapped in this:
//
//   export const GET = route(async (req, { params }: Ctx) => { … })
//
// 1. CROSS-SITE WRITES ARE REFUSED. The session is a cookie, so any site the
//    user visits could otherwise POST here with it attached. SameSite=Lax
//    already stops most of that. This is the second lock: an unsafe method
//    from another site is answered 403 before the handler runs. Decided from
//    the Fetch Metadata header browsers send (Sec-Fetch-Site), falling back to
//    Origin. A request with neither is not from a browser (curl, a server)
//    and carries no ambient cookie to abuse.
//
// 2. requireUser() throws Unauthenticated when there is no session. That
//    becomes the 401 every route used to write out by hand.
//
// 3. Anything else unexpected becomes a JSON 500 rather than Next's empty 500
//    body, which every client here would fail to parse. Repositories THROW on
//    database failure (see app/lib/db/errors.ts). The throw is logged with the
//    method and path, and answered with a generic message. PostgreSQL's own
//    text is not sent to the browser; it can name tables, columns and
//    constraint internals. The errors a route SHOULD handle, constraint
//    violations that are the user's mistake, it catches itself with
//    isConstraint() before this.
// ─────────────────────────────────────────────────────────────────────────────

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isCrossSite(req: NextRequest): boolean {
  if (!UNSAFE.has(req.method)) return false
  const site = req.headers.get('sec-fetch-site')
  if (site) return site !== 'same-origin' && site !== 'none'
  const origin = req.headers.get('origin')
  if (!origin) return false
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

export function route<Ctx = unknown>(
  handler: (req: NextRequest, ctx: Ctx) => Promise<Response>
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async function wrapped(req: NextRequest, ctx: Ctx): Promise<Response> {
    if (isCrossSite(req)) {
      return Response.json({ error: 'Cross-site request refused' }, { status: 403 })
    }
    try {
      return await handler(req, ctx)
    } catch (err) {
      if (err instanceof Unauthenticated) {
        return Response.json({ error: 'Not authenticated' }, { status: 401 })
      }
      console.error(`[route] ${req.method} ${req.nextUrl.pathname} failed`, err)
      return Response.json(
        { error: 'Something went wrong on our side. Please try again.' },
        { status: 500 }
      )
    }
  }
}
