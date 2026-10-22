import { describe, expect, it } from 'vitest'
import { parseServerBaseUrl, resolveServerConfig } from '../../src/main/connection/server-config'
import { createServerClient } from '../../src/main/connection/create-server-client'

describe('server address', () => {
  it('uses JARVIS_SERVER_URL in an unpackaged app and normalises it', () => {
    expect(
      resolveServerConfig({
        isPackaged: false,
        env: { JARVIS_SERVER_URL: 'http://127.0.0.1:8000/api/v1/' }
      })
    ).toEqual({ status: 'ready', baseUrl: 'http://127.0.0.1:8000/api/v1' })
    expect(
      resolveServerConfig({
        isPackaged: false,
        env: { JARVIS_SERVER_URL: 'https://api.example.com' }
      })
    ).toEqual({ status: 'ready', baseUrl: 'https://api.example.com' })
  })

  it('stays unconfigured without a value, and a packaged build ignores the variable', () => {
    expect(resolveServerConfig({ isPackaged: false, env: {} })).toEqual({ status: 'unconfigured' })
    expect(resolveServerConfig({ isPackaged: false, env: { JARVIS_SERVER_URL: '  ' } })).toEqual({
      status: 'unconfigured'
    })
    expect(
      resolveServerConfig({
        isPackaged: true,
        env: { JARVIS_SERVER_URL: 'https://api.example.com/api/v1' }
      })
    ).toEqual({ status: 'unconfigured' })
  })

  it('allows plain http only for this machine', () => {
    for (const ok of ['http://127.0.0.1:8000/api/v1', 'http://localhost:8000', 'http://[::1]:8000'])
      expect(parseServerBaseUrl(ok).status).toBe('ready')
    for (const bad of [
      'http://example.com/api/v1',
      'http://127.0.0.1.evil.com/api/v1',
      'http://localhost.evil.com',
      'http://10.0.0.5:8000'
    ])
      expect(parseServerBaseUrl(bad)).toMatchObject({ status: 'invalid' })
  })

  it('rejects addresses that are not a plain base address', () => {
    for (const bad of [
      'ftp://example.com',
      'javascript:alert(1)',
      'https://user:pass@example.com/api',
      'https://example.com/api?x=1',
      'https://example.com/api#frag',
      ' https://example.com',
      'https://example.com ',
      'not a url',
      'file:///etc/passwd'
    ])
      expect(parseServerBaseUrl(bad)).toMatchObject({ status: 'invalid' })
  })

  it('reports why an address is invalid without echoing it', () => {
    const result = parseServerBaseUrl('https://user:secretpass@example.com')
    expect(result.status).toBe('invalid')
    expect(JSON.stringify(result)).not.toContain('secretpass')
  })

  it('builds a client only for a usable address', () => {
    const make = (env: Record<string, string>, isPackaged = false) =>
      createServerClient({
        isPackaged,
        env,
        fetch: async () => new Response(),
        accessToken: () => null
      })
    expect(make({}).status).toBe('unconfigured')
    expect(make({ JARVIS_SERVER_URL: 'http://example.com' }).status).toBe('invalid')
    expect(make({ JARVIS_SERVER_URL: 'http://127.0.0.1:8000/api/v1' }).status).toBe('ready')
    expect(make({ JARVIS_SERVER_URL: 'http://127.0.0.1:8000/api/v1' }, true).status).toBe(
      'unconfigured'
    )
  })
})
