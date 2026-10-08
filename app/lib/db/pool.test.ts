import { describe, it, expect, vi, afterEach } from 'vitest'
import { tlsOptions } from './pool'

describe('database TLS', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('loopback is plaintext', () => {
    expect(tlsOptions('localhost')).toBeUndefined()
    expect(tlsOptions('127.0.0.1')).toBeUndefined()
  })

  it('verifies the server when the CA is configured', () => {
    vi.stubEnv('DATABASE_CA_CERT', '-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----')
    expect(tlsOptions('db.example.com')).toEqual({
      ca: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
      rejectUnauthorized: true,
    })
  })

  it('without a CA it still encrypts, and says loudly that it is not verifying', () => {
    vi.stubEnv('DATABASE_CA_CERT', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(tlsOptions('db.example.com')).toEqual({ rejectUnauthorized: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT verifying'))
  })
})
