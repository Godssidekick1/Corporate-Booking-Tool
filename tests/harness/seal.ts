import { NextRequest } from 'next/server'
import { POST as challenge } from '@/app/api/auth/signin/challenge/route'
import { sealFields } from '@/app/lib/auth/sealClient'
import type { SealChallenge, SealFields, SealPurpose, SealedSecret } from '@/app/lib/auth/sealProtocol'

// ── A form's secrets sealed as the page seals them ───────────────────────────
// A fresh challenge from the real endpoint, then app/lib/auth/sealClient.ts.
// Each call comes from its own documentation-range address, so a long test
// file never meets the challenge endpoint's per-IP limit.
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0

export async function freshChallenge(): Promise<SealChallenge> {
  const ip = `198.18.${Math.floor(seq / 250)}.${(seq++ % 250) + 1}`
  const res = await challenge(new NextRequest(new URL('/api/auth/signin/challenge', 'http://localhost'), {
    method: 'POST', headers: { 'x-forwarded-for': ip },
  }), { params: Promise.resolve({}) })
  if (res.status !== 200) throw new Error(`challenge answered ${res.status}`)
  return res.json() as Promise<SealChallenge>
}

export async function sealedFor<P extends SealPurpose>(purpose: P, fields: SealFields<P>): Promise<SealedSecret> {
  return sealFields(purpose, fields, await freshChallenge())
}
