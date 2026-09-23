import { NextRequest } from 'next/server'
import { actAs, type TestUser } from './session'

// ── Calling a route handler directly ─────────────────────────────────────────
// Route handlers are exported async functions. With auth mocked
// (tests/setup/auth.ts) they can be called as plain functions against the test
// database -- no server, no browser, no login.
//
//   const res = await call(GET, { as: a.tmcAdmin, url: '/api/tmc/clients?page=1' })
//   expect(res.status).toBe(200)
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

export interface CallOptions {
  as?: TestUser | null
  url: string
  method?: string
  body?: unknown
  params?: Record<string, string>
  headers?: Record<string, string>
}

export interface CallResult {
  status: number
  // Parsed JSON when the body is JSON, the raw text otherwise.
  json: unknown
}

export async function call(handler: unknown, options: CallOptions): Promise<CallResult> {
  actAs(options.as ?? null)

  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...options.headers },
  }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)

  const req = new NextRequest(new URL(options.url, 'http://localhost'), init)
  // Next 16 passes params as a Promise; handlers await it.
  const res = await (handler as Handler)(req, { params: Promise.resolve(options.params ?? {}) })

  const text = await res.text()
  let json: unknown = text
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // Not JSON -- keep the text.
  }
  return { status: res.status, json }
}
