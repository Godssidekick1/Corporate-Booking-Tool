import type { NextRequest } from 'next/server'

// ── route() ──────────────────────────────────────────────────────────────────
// NOTE THE FILENAME. This lives in app/, where Next treats any file called
// route.ts as a route handler; named route.ts it registered /lib/http as an
// endpoint and failed the build's type check. Never name a helper here
// route.ts, page.tsx or layout.tsx.
//
// Wraps a route handler so an unexpected throw becomes a JSON 500 rather than
// Next's default empty 500 body, which every client here would fail to parse.
//
//   export const GET = route(async (req, { params }: Ctx) => { … })
//
// Repositories THROW on database failure (see app/lib/db/errors.ts). Most of
// those throws are not the route's to handle -- a lost connection is not a
// user mistake -- so they land here: logged with the method and path, and
// answered with a generic message. PostgreSQL's own error text is not sent to
// the browser; it can name tables, columns and constraint internals.
//
// The errors a route SHOULD handle -- constraint violations that are the
// user's mistake -- it catches itself, with isConstraint(), before this.
// ─────────────────────────────────────────────────────────────────────────────

export function route<Ctx = unknown>(
  handler: (req: NextRequest, ctx: Ctx) => Promise<Response>
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async function wrapped(req: NextRequest, ctx: Ctx): Promise<Response> {
    try {
      return await handler(req, ctx)
    } catch (err) {
      console.error(`[route] ${req.method} ${req.nextUrl.pathname} failed`, err)
      return Response.json(
        { error: 'Something went wrong on our side. Please try again.' },
        { status: 500 }
      )
    }
  }
}
