import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EmptyResponse, ServerClient } from '../../src/main/connection/server-client'
import { ServerIdSchema } from '../../src/main/connection/server-ids'

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

/** A real server on this machine, so requests travel the actual network stack. */
async function listen(handler: Handler) {
  const seen: { headers: IncomingHttpHeaders; url: string; method: string; body: string }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen.push({
        headers: request.headers,
        url: request.url ?? '',
        method: request.method ?? '',
        body
      })
      handler(request, response, body)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const client = new ServerClient({
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    fetch: (input, init) => fetch(input, init),
    accessToken: () => 'tok_integration.secret'
  })
  return { client, seen, port, server }
}

describe('server client over a real connection', () => {
  it('sends the request as built and reads a JSON answer and the server clock', async () => {
    const { client, seen } = await listen((_request, response) => {
      response.writeHead(201, {
        'content-type': 'application/json',
        date: 'Thu, 22 Oct 2026 00:00:30 GMT'
      })
      response.end(JSON.stringify({ command_id: 8801, status: 'success' }))
    })
    const result = await client.request({
      method: 'POST',
      path: '/commands/8801/results',
      body: { attempt_no: 1, status: 'success' },
      idempotencyKey: 'idem-integration-1',
      response: z.object({ command_id: ServerIdSchema, status: z.string() })
    })
    expect(result).toEqual({
      ok: true,
      value: { command_id: '8801', status: 'success' },
      status: 201
    })
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/v1/commands/8801/results' })
    expect(seen[0]!.headers.authorization).toBe('Bearer tok_integration.secret')
    expect(seen[0]!.headers['idempotency-key']).toBe('idem-integration-1')
    expect(seen[0]!.headers['content-type']).toBe('application/json')
    expect(JSON.parse(seen[0]!.body)).toEqual({ attempt_no: 1, status: 'success' })
    expect(client.clock.offsetMs).not.toBeNull()
  })

  it('maps an error envelope and an empty success', async () => {
    const { client } = await listen((request, response) => {
      if (request.url?.endsWith('/auth/logout')) return void response.writeHead(204).end()
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { code: 'INVALID_SESSION', message: 'x', request_id: 'req-1' } })
      )
    })
    expect(
      await client.request({ method: 'POST', path: '/auth/logout', response: EmptyResponse })
    ).toEqual({
      ok: true,
      value: undefined,
      status: 204
    })
    expect(
      await client.request({ method: 'GET', path: '/auth/me', response: z.unknown() })
    ).toMatchObject({
      ok: false,
      error: { code: 'session_expired' },
      detail: {
        delivery: 'responded',
        status: 401,
        serverCode: 'INVALID_SESSION',
        requestId: 'req-1'
      }
    })
  })

  it('does not follow a redirect to another host', async () => {
    const { client, seen } = await listen((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end()
    })
    expect(
      await client.request({ method: 'GET', path: '/x', response: z.unknown() })
    ).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
      detail: { delivery: 'responded', status: 302 }
    })
    expect(seen).toHaveLength(1)
  })

  it('refuses an answer that is larger than allowed while it streams', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"data":"')
      response.end('a'.repeat(5000) + '"}')
    })
    const client = new ServerClient({
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      fetch: (input, init) => fetch(input, init),
      accessToken: () => 'tok',
      maxResponseBytes: 1000
    })
    expect(
      await client.request({ method: 'GET', path: '/big', response: z.unknown() })
    ).toMatchObject({
      ok: false,
      error: { code: 'internal' }
    })
  })

  it('reports a server that never answers as possibly sent after the time limit', async () => {
    const { client, seen } = await listen(() => {
      /* Accept the request and say nothing. */
    })
    const result = await client.request({
      method: 'POST',
      path: '/auth/refresh',
      body: {},
      response: z.unknown(),
      timeoutMs: 100
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
      detail: { delivery: 'no_response' }
    })
    expect(seen).toHaveLength(1)
  })

  it('reports a connection that is cut after the request was sent as possibly sent', async () => {
    const { client, seen } = await listen((request) => {
      request.socket.destroy()
    })
    const result = await client.request({
      method: 'POST',
      path: '/auth/refresh',
      body: {},
      response: z.unknown()
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
      detail: { delivery: 'no_response' }
    })
    expect(seen).toHaveLength(1)
  })

  it('reports a refused connection as not sent', async () => {
    const { client, server, seen } = await listen(() => undefined)
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    const result = await client.request({
      method: 'POST',
      path: '/auth/refresh',
      body: {},
      response: z.unknown()
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
      detail: { delivery: 'not_sent' }
    })
    expect(seen).toHaveLength(0)
  })

  it('stops waiting when the caller cancels', async () => {
    const { client } = await listen(() => undefined)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    expect(
      await client.request({
        method: 'GET',
        path: '/slow',
        response: z.unknown(),
        signal: controller.signal
      })
    ).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})
