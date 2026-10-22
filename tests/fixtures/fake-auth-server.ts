import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const ACCESS_LIFETIME_S = 3600
export const REFRESH_LIFETIME_S = 2_592_000

export type RefreshMode = 'ok' | 'drop' | 'broken' | 'error503'

export interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
  authorization: string | undefined
}

/**
 * A stand-in for the server's authentication: it rotates refresh tokens, treats a retired one as a
 * leak and revokes the session, and can lose, break or fail a refresh answer on demand.
 */
export class FakeAuthServer {
  readonly users = new Map<string, string>()
  readonly calls: Call[] = []
  readonly retired = new Set<string>()
  readonly revokedAccess = new Set<string>()
  refreshMode: RefreshMode = 'ok'
  /** Faults for the next refresh calls only, consumed in order before `refreshMode` applies. */
  refreshOnce: RefreshMode[] = []
  /** How long after a renewal the previous refresh token is still accepted once more. */
  graceMs = 30_000
  rateLimitChecks = false
  /** How long a submitted request takes before the server has an answer. */
  processingMs = 20
  /** What a finished request turns out as. */
  outcome: 'success' | 'failed' | 'rejected' = 'success'
  withCommands = false
  /** Process the next submit, then drop the connection without answering. */
  dropNextSubmitAnswer = false
  readonly conversationsMade: string[] = []
  /** Commands the server has for the device, in order. A command with a stored result is not pending. */
  readonly commands: {
    command_id: number
    attempt_no: number
    command_type: string
    requested_app_code: string | null
    arguments: Record<string, unknown>
    requested_at: string
  }[] = []
  /** Stored results by command ID, as the server keeps them. */
  readonly results = new Map<number, Record<string, unknown>>()
  /** Answers for the next result reports, consumed in order: a status code, or 'drop' to lose the answer after storing. */
  resultFaults: (number | 'drop')[] = []
  /** Items placed in the pending list as they are, to try a malformed one. */
  rawPending: unknown[] = []
  pollAfterMs = 2000
  readonly processed: { requestId: string; content: string }[] = []
  private conversationKeys = new Map<string, string>()
  private serverRequests = new Map<
    string,
    { conversation: string; content: string; doneAt: number }
  >()
  private sessions: {
    id: string
    user: string
    access: string
    refresh: string
    previous: string | null
    rotatedAt: number
    graceUsed: boolean
    revoked: boolean
  }[] = []
  private counter = 0

  /** The server ends every session, as if an administrator revoked them. */
  endAllSessions(): void {
    for (const session of this.sessions) session.revoked = true
  }

  count(path: string): number {
    return this.calls.filter((call) => call.path === path).length
  }

  handle(request: IncomingMessage, response: ServerResponse, raw: string): void {
    const body = raw === '' ? null : (JSON.parse(raw) as Record<string, unknown>)
    const path = (request.url ?? '').replace('/api/v1', '')
    this.calls.push({
      method: request.method ?? '',
      path,
      body,
      authorization: request.headers.authorization
    })
    const send = (status: number, payload?: unknown) => {
      if (payload === undefined) return void response.writeHead(status).end()
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    const error = (status: number, code: string) => send(status, { error: { code, message: 'x' } })

    if (path === '/auth/register') {
      const username = String(body?.username ?? '').toLowerCase()
      if (this.users.has(username)) return error(409, 'USERNAME_TAKEN')
      if (username.length < 3) return error(422, 'VALIDATION_ERROR')
      this.users.set(username, String(body?.password))
      return send(201, { user_id: `uuid-${username}`, username, role: 'user', created_at: 'x' })
    }
    if (path === '/auth/login') {
      const username = String(body?.username ?? '').toLowerCase()
      if (this.users.get(username) !== body?.password) return error(401, 'INVALID_CREDENTIALS')
      const session = this.open(username)
      return send(200, {
        ...this.tokens(session),
        token_type: 'Bearer',
        session_id: session.id,
        user: { user_id: `uuid-${username}`, username, role: 'user' },
        device: { device_id: 12, device_name: 'x', platform: 'windows' }
      })
    }
    if (path === '/auth/username-checks') {
      if (this.rateLimitChecks) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' })
        return void response.end(JSON.stringify({ detail: { code: 'RATE_LIMITED' } }))
      }
      const username = String(body?.username ?? '')
      if (username.length < 3) return error(422, 'VALIDATION_ERROR')
      const lower = username.toLowerCase()
      return send(200, { username: lower, available: !this.users.has(lower) })
    }
    if (path === '/auth/refresh') {
      const token = String(body?.refresh_token)
      const mode = this.refreshOnce.shift() ?? this.refreshMode
      const current = this.sessions.find((candidate) => candidate.refresh === token)
      const prior = this.sessions.find((candidate) => candidate.previous === token)
      let target = current
      if (!current && prior && !prior.revoked) {
        // The previous token again: forgiven once, shortly after the renewal; otherwise a leak.
        if (Date.now() - prior.rotatedAt <= this.graceMs && !prior.graceUsed) {
          prior.graceUsed = true
          target = prior
        } else {
          prior.revoked = true
          return error(401, 'REFRESH_TOKEN_REUSED')
        }
      }
      if (!target || target.revoked) return error(401, 'INVALID_SESSION')
      if (mode === 'error503') return error(503, 'SERVICE_UNAVAILABLE')
      target.previous = target.refresh
      this.retired.add(target.refresh)
      target.access = `acc_${++this.counter}`
      target.refresh = `ref_${++this.counter}`
      target.rotatedAt = Date.now()
      if (mode === 'drop') return void request.socket.destroy()
      if (mode === 'broken') {
        response.writeHead(200, { 'content-type': 'application/json' })
        return void response.end('{"access_token": ')
      }
      return send(200, { ...this.tokens(target), token_type: 'Bearer' })
    }
    const session = this.sessions.find(
      (candidate) => `Bearer ${candidate.access}` === request.headers.authorization
    )
    const valid = session && !session.revoked && !this.revokedAccess.has(session.access)
    if (path === '/auth/me') {
      if (!valid) return error(401, 'INVALID_SESSION')
      return send(200, {
        user: { user_id: `uuid-${session.user}`, username: session.user, role: 'user' },
        device: { device_id: 12, device_name: 'x', platform: 'windows' }
      })
    }
    if (path === '/ping') {
      if (!valid) return error(401, 'INVALID_SESSION')
      return send(200, { ok: true, user: session.user })
    }
    if (path === '/conversations' && request.method === 'POST') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const key = String(request.headers['idempotency-key'] ?? '')
      const known = key ? this.conversationKeys.get(key) : undefined
      if (known) return send(201, { conversation_id: known, created_at: 'x', updated_at: 'x' })
      const id = `conv_${++this.counter}`
      this.conversationsMade.push(id)
      if (key) this.conversationKeys.set(key, id)
      return send(201, { conversation_id: id, created_at: 'x', updated_at: 'x' })
    }
    const messages = /^\/conversations\/([^/]+)\/messages$/.exec(path)
    if (messages && request.method === 'POST') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const conversation = decodeURIComponent(messages[1]!)
      if (!this.conversationsMade.includes(conversation)) return error(404, 'RESOURCE_NOT_FOUND')
      const requestId = String(body?.request_id)
      const existing = this.serverRequests.get(requestId)
      if (!existing) {
        const busy = [...this.serverRequests.values()].some(
          (other) => other.conversation === conversation && other.doneAt > Date.now()
        )
        if (busy) return error(409, 'CONVERSATION_BUSY')
        this.serverRequests.set(requestId, {
          conversation,
          content: String(body?.content),
          doneAt: Date.now() + this.processingMs
        })
        this.processed.push({ requestId, content: String(body?.content) })
        if (this.dropNextSubmitAnswer) {
          this.dropNextSubmitAnswer = false
          return void request.socket.destroy()
        }
      }
      return send(202, {
        request_id: requestId,
        message_id: this.processed.length,
        processing_status: 'queued',
        status_url: `/api/v1/requests/${requestId}`,
        poll_after_ms: 500
      })
    }
    const requestStatus = /^\/requests\/([^/]+)$/.exec(path)
    if (requestStatus && request.method === 'GET') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const found = this.serverRequests.get(decodeURIComponent(requestStatus[1]!))
      if (!found) return error(404, 'RESOURCE_NOT_FOUND')
      const base = {
        request_id: decodeURIComponent(requestStatus[1]!),
        conversation_id: found.conversation,
        transcript: null,
        recommendation: null
      }
      if (Date.now() < found.doneAt)
        return send(200, {
          ...base,
          processing_status: 'processing',
          error_code: null,
          assistant_messages: [],
          commands: []
        })
      if (this.outcome !== 'success')
        return send(200, {
          ...base,
          processing_status: this.outcome,
          error_code: 'SERVER_DETAIL_THAT_MUST_NOT_SHOW',
          assistant_messages: [],
          commands: []
        })
      return send(200, {
        ...base,
        processing_status: 'success',
        error_code: null,
        assistant_messages: [
          { message_id: 2, role: 'assistant', content: `echo: ${found.content}` }
        ],
        commands: this.withCommands
          ? [{ command_id: 8801, command_type: 'apps.launch', latest_result: null }]
          : []
      })
    }
    if (path.startsWith('/device/commands/pending') && request.method === 'GET') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const items = [
        ...this.commands.filter((command) => !this.results.has(command.command_id)),
        ...this.rawPending
      ]
      return send(200, { items, poll_after_ms: this.pollAfterMs })
    }
    const report = /^\/commands\/(\d+)\/results$/.exec(path)
    if (report && request.method === 'POST') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const commandId = Number(report[1])
      const fault = this.resultFaults.shift()
      if (typeof fault === 'number') return error(fault, 'FAULT')
      if (!this.commands.some((command) => command.command_id === commandId))
        return error(404, 'COMMAND_NOT_FOUND')
      const allowed = new Set([
        'attempt_no',
        'status',
        'observation_status',
        'error_code',
        'failure_stage',
        'result_message',
        'started_at',
        'finished_at',
        'reported_at',
        'app',
        'activity'
      ])
      const fields = Object.keys(body ?? {})
      const required = [
        'attempt_no',
        'status',
        'observation_status',
        'started_at',
        'finished_at',
        'reported_at'
      ]
      const malformed =
        fields.some((field) => !allowed.has(field)) ||
        required.some((field) => !fields.includes(field)) ||
        (['success', 'unknown'].includes(String(body?.status)) &&
          body?.failure_stage !== undefined &&
          body?.failure_stage !== null) ||
        Date.parse(String(body?.finished_at)) < Date.parse(String(body?.started_at))
      if (malformed) return error(422, 'VALIDATION_ERROR')
      const prior = this.results.get(commandId)
      if (prior && JSON.stringify(prior) !== JSON.stringify(body))
        return error(409, 'COMMAND_RESULT_CONFLICT')
      if (!prior) this.results.set(commandId, body ?? {})
      if (fault === 'drop') return void request.socket.destroy()
      return send(prior ? 200 : 201, {
        command_id: commandId,
        attempt_no: body?.attempt_no,
        status: body?.status,
        activity_recorded: false
      })
    }
    if (path === '/auth/logout') {
      if (!valid) return error(401, 'INVALID_SESSION')
      session.revoked = true
      return send(204)
    }
    return error(404, 'NOT_FOUND')
  }

  private open(user: string) {
    const session = {
      id: `sess-${++this.counter}`,
      user,
      access: `acc_${++this.counter}`,
      refresh: `ref_${++this.counter}`,
      previous: null,
      rotatedAt: 0,
      graceUsed: false,
      revoked: false
    }
    this.sessions.push(session)
    return session
  }

  private tokens(session: { access: string; refresh: string }) {
    return {
      access_token: session.access,
      refresh_token: session.refresh,
      access_expires_in: ACCESS_LIFETIME_S,
      refresh_expires_in: REFRESH_LIFETIME_S
    }
  }
}

const running: Server[] = []

/** A real server on this machine for the fake to answer from, so requests cross the network stack. */
export async function startFakeServer(fake = new FakeAuthServer()) {
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => fake.handle(request, response, raw))
  })
  running.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { fake, server, port, baseUrl: `http://127.0.0.1:${port}/api/v1` }
}

export async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

/** For `afterEach`: closes whatever `startFakeServer` started. */
export async function stopAllFakeServers(): Promise<void> {
  await Promise.all(running.splice(0).map(stopServer))
}
