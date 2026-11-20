import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { clientIp } from './request'

// ── The client's IP behind a reverse proxy ───────────────────────────────────
// The proxy appends what it saw; anything earlier came from the client.

const req = (headers: Record<string, string>) => new NextRequest(new URL('http://localhost/x'), { headers })

describe('clientIp', () => {
  afterEach(() => { delete process.env.TRUSTED_PROXY_HOPS })

  it('the address the proxy appended, not one the client sent', () => {
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.20' }))).toBe('198.51.100.20')
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 198.51.100.20' }))).toBe('198.51.100.20')
  })

  it('a single entry (one proxy, or Vercel) is that entry', () => {
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.20' }))).toBe('198.51.100.20')
  })

  it('two proxies in front: the entry the outer one appended', () => {
    process.env.TRUSTED_PROXY_HOPS = '2'
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.20, 10.0.0.5' }))).toBe('198.51.100.20')
  })

  it('no header: X-Real-IP, else unknown', () => {
    expect(clientIp(req({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9')
    expect(clientIp(req({}))).toBeNull()
  })
})
