import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FakeCalendarStore } from './fake-calendar-store'
import type { FakeGoogleConnections } from './fake-google-connections'

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
 * A stand-in for the Jarvis server, answering over real HTTP. It covers what the client calls:
 * sign-up, sign-in and token renewal (it rotates refresh tokens, treats a retired one as a leak and
 * revokes the session, and can lose, break or fail a refresh answer on demand), conversations and
 * requests (typed and spoken), speech synthesis, device commands and their results, and
 * recommendations and calendar reads. Each area has switches to make it slow, wrong or silent on demand.
 */
export class FakeJarvisServer {
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
  /**
   * The user's settings, as `GET /me/settings` answers. The collection fields decide whether a
   * command result's activity is recorded, as on the real server: only for a success, with the
   * activity consent on and the same `collection_revision`.
   */
  calendarSettings: Record<string, unknown> = {
    timezone: 'Asia/Seoul',
    activity_collection_enabled: true,
    external_activity_collection_enabled: true,
    collection_revision: 3
  }
  /** Activities the server recorded from command results, in order. */
  readonly activities: {
    commandId: number
    eventKey: string
    eventType: string
    appCode: string
    occurredAt: string
    runningApps: string[] | null
  }[] = []
  calendarAnswer: unknown = { items: [], todos: [] }
  /** When set, the calendar is kept here and follows the real server's rules, and `calendarAnswer` is not used. */
  calendarStore: FakeCalendarStore | null = null
  /** When set, the Google Calendar connection is kept here and follows the real server's behavior. */
  google: FakeGoogleConnections | null = null
  calendarFaults: number[] = []
  /** Hold an event response to test sign-out or a newer read overtaking it. */
  calendarGate: Promise<void> | null = null
  /** How long a submitted request takes before the server has an answer. */
  processingMs = 20
  /** What a finished request turns out as. */
  outcome: 'success' | 'failed' | 'rejected' = 'success'
  withCommands = false
  /** Process the next submit, then drop the connection without answering. */
  dropNextSubmitAnswer = false
  readonly conversationsMade: string[] = []
  /** What recognition makes of the next spoken requests, in order; then `defaultTranscript`. */
  transcripts: string[] = []
  defaultTranscript = '크롬 열어줘'
  /** What happens to recognition of the next spoken requests: it hears, hears nothing, or breaks. */
  sttModes: ('ok' | 'empty' | 'error')[] = []
  /** How long recognition takes, before the transcript can be read; the answer takes `processingMs`. */
  sttMs = 40
  readonly voiceUploads: { requestId: string; bytes: number; filename: string }[] = []
  readonly ttsTexts: string[] = []
  /** Answers for the next speech syntheses: a status code, or 'ok'. */
  ttsFaults: (number | 'ok')[] = []
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
  /** The recommendation the server offers next (null for none), as the real server would. */
  recommendation: {
    recommendation_id: number
    reason: string
    /** ISO time; sent without its zone when `naiveTimes` is on. */
    expires_at: string
    targets: {
      position: number
      device_app_id: number
      app_code: string | null
      display_name: string
    }[]
  } | null = null
  /** Answers recorded for recommendations, by ID. */
  readonly recommendationAnswers = new Map<number, string>()
  /** Statuses for the next recommendation answers (consumed in order), or 'ok'. */
  recommendationFaults: (number | 'ok')[] = []
  /** Send `requested_at` without a zone, like the real server. */
  naiveTimes = true
  readonly processed: { requestId: string; content: string }[] = []
  private conversationKeys = new Map<string, string>()
  private serverRequests = new Map<
    string,
    {
      conversation: string
      content: string
      doneAt: number
      voice?: { transcript: string; mode: 'ok' | 'empty' | 'error'; sttAt: number }
    }
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

  handle(
    request: IncomingMessage,
    response: ServerResponse,
    raw: string,
    bytes: Buffer = Buffer.from(raw)
  ): void {
    const contentType = String(request.headers['content-type'] ?? '')
    const multipart = contentType.startsWith('multipart/form-data')
      ? parseMultipart(bytes, contentType)
      : null
    const body = raw === '' || multipart ? null : (JSON.parse(raw) as Record<string, unknown>)
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
    if (path === '/me/settings' && request.method === 'GET') {
      if (!valid) return error(401, 'INVALID_SESSION')
      return send(200, this.calendarSettings)
    }
    const google = this.google
    const connectionRoute =
      /^\/calendar\/connections(?:\/(google)\/authorizations|\/(\d+)\/syncs|\/(\d+))?$/.exec(path)
    if (google && connectionRoute) {
      if (!valid) return error(401, 'INVALID_SESSION')
      const method = request.method
      if (!connectionRoute[1] && !connectionRoute[2] && !connectionRoute[3] && method === 'GET') {
        const fault = google.readFaults.shift() ?? 'ok'
        if (typeof fault === 'number') return error(fault, 'SERVICE_UNAVAILABLE')
        return send(200, google.list(this.naiveTimes))
      }
      if (connectionRoute[1] && method === 'POST')
        return send(201, google.authorize(this.naiveTimes))
      if (connectionRoute[2] && method === 'POST') {
        const answered = google.sync(Number(connectionRoute[2]))
        return send(answered.status, answered.payload)
      }
      if (connectionRoute[3] && method === 'DELETE') {
        const answered = google.disconnect(Number(connectionRoute[3]))
        return send(answered.status, answered.payload)
      }
      return error(405, 'METHOD_NOT_ALLOWED')
    }
    const store = this.calendarStore
    const eventRoute = /^\/calendar\/events(?:\/(\d+))?(?:\?.*)?$/.exec(path)
    if (store && eventRoute) {
      if (!valid) return error(401, 'INVALID_SESSION')
      const id = eventRoute[1] === undefined ? null : Number(eventRoute[1])
      const method = request.method
      if (method === 'GET' && id === null) {
        const query = new URL(`http://x${path}`).searchParams
        const answered = store.list(
          query.get('from') ?? '',
          query.get('to') ?? '',
          query.get('include_todos') === 'true'
        )
        return send(answered.status, answered.payload)
      }
      if (
        (method === 'POST' && id === null) ||
        (method === 'PATCH' && id !== null) ||
        (method === 'DELETE' && id !== null)
      ) {
        const fault = store.faults.shift() ?? 'ok'
        if (typeof fault === 'number') return error(fault, 'FAULT')
        const answered =
          method === 'POST'
            ? store.create(body)
            : method === 'PATCH'
              ? store.update(id!, body)
              : store.remove(id!)
        if (fault === 'lost') return void request.socket.destroy()
        return send(answered.status, answered.payload)
      }
      return error(405, 'METHOD_NOT_ALLOWED')
    }
    if (path.startsWith('/calendar/events?') && request.method === 'GET') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const status = this.calendarFaults.shift() ?? 200
      if (status !== 200) return error(status, 'SERVICE_UNAVAILABLE')
      const answer = this.calendarAnswer
      if (this.calendarGate) {
        void this.calendarGate.then(() => send(200, answer))
        return
      }
      return send(200, answer)
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
      let voiceBytes: Buffer | null = null
      if (multipart) {
        // The server's own checks on an uploaded utterance.
        const upload = multipart.files.find((file) => file.name === 'audio')
        if (
          typeof multipart.fields.request_id !== 'string' ||
          multipart.fields.input_method !== 'voice' ||
          !upload
        )
          return error(422, 'VALIDATION_ERROR')
        if (upload.bytes.length > 700_000) return error(413, 'AUDIO_TOO_LARGE')
        const format = wavFormat(upload.bytes)
        if (!format) return error(422, 'UNSUPPORTED_AUDIO_FORMAT')
        if (format.seconds < 0.1 || format.seconds > 20) return error(422, 'VALIDATION_ERROR')
        voiceBytes = upload.bytes
        this.voiceUploads.push({
          requestId: multipart.fields.request_id,
          bytes: upload.bytes.length,
          filename: upload.filename
        })
      }
      const requestId = String(multipart ? multipart.fields.request_id : body?.request_id)
      const existing = this.serverRequests.get(requestId)
      if (!existing) {
        const busy = [...this.serverRequests.values()].some(
          (other) => other.conversation === conversation && other.doneAt > Date.now()
        )
        if (busy) return error(409, 'CONVERSATION_BUSY')
        const voice = voiceBytes
          ? {
              transcript: this.transcripts.shift() ?? this.defaultTranscript,
              mode: this.sttModes.shift() ?? 'ok',
              sttAt: Date.now() + this.sttMs
            }
          : undefined
        const content = voice ? voice.transcript : String(body?.content)
        this.serverRequests.set(requestId, {
          conversation,
          content,
          doneAt: Date.now() + this.processingMs,
          ...(voice ? { voice } : {})
        })
        this.processed.push({ requestId, content })
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
      // Recognition always ends before the answer does, as on the real server.
      const heard =
        found.voice &&
        found.voice.mode === 'ok' &&
        (Date.now() >= found.voice.sttAt || Date.now() >= found.doneAt)
      const base = {
        request_id: decodeURIComponent(requestStatus[1]!),
        conversation_id: found.conversation,
        transcript: heard ? found.voice!.transcript : null,
        recommendation: null
      }
      if (found.voice && found.voice.mode !== 'ok' && Date.now() >= found.voice.sttAt)
        return send(200, {
          ...base,
          processing_status: 'failed',
          error_code: found.voice.mode === 'empty' ? 'SPEECH_NOT_RECOGNIZED' : 'STT_FAILED',
          assistant_messages: [],
          commands: []
        })
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
      // The real server sends the time without a zone, as UTC (a command may still carry one).
      return send(200, {
        items: items.map((item) =>
          typeof (item as { requested_at?: unknown }).requested_at === 'string' && this.naiveTimes
            ? {
                ...(item as object),
                requested_at: (item as { requested_at: string }).requested_at.replace(/Z$/, '')
              }
            : item
        ),
        poll_after_ms: this.pollAfterMs
      })
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
      const activity = body?.activity as Record<string, unknown> | undefined
      if (activity !== undefined) {
        // What the server's model refuses: an activity without its app, a stranger's key, a bad list.
        const keys = [
          'event_key',
          'event_type',
          'occurred_at',
          'collection_revision',
          'running_apps'
        ]
        const bad =
          typeof activity !== 'object' ||
          body?.app === undefined ||
          Object.keys(activity).some((key) => !keys.includes(key)) ||
          typeof activity.event_key !== 'string' ||
          activity.event_key.length < 1 ||
          activity.event_key.length > 160 ||
          !['launched', 'activated', 'closed'].includes(String(activity.event_type)) ||
          !Number.isInteger(activity.collection_revision) ||
          (activity.running_apps !== undefined &&
            (!Array.isArray(activity.running_apps) ||
              activity.running_apps.length > 100 ||
              activity.running_apps.some((code) => typeof code !== 'string')))
        if (bad) return error(422, 'VALIDATION_ERROR')
      }
      // A result sent again is compared on these fields only; what it says about activity is ignored.
      const compared = [
        'status',
        'observation_status',
        'error_code',
        'failure_stage',
        'result_message',
        'started_at',
        'finished_at',
        'reported_at'
      ]
      const prior = this.results.get(commandId)
      if (prior && compared.some((field) => (prior[field] ?? null) !== (body?.[field] ?? null)))
        return error(409, 'COMMAND_RESULT_CONFLICT')
      let recorded = this.activities.some((entry) => entry.commandId === commandId)
      if (!prior) {
        this.results.set(commandId, body ?? {})
        const settings = this.calendarSettings
        if (
          activity !== undefined &&
          body?.status === 'success' &&
          settings.activity_collection_enabled === true &&
          settings.collection_revision === activity.collection_revision
        ) {
          const app = body.app as Record<string, unknown>
          this.activities.push({
            commandId,
            eventKey: String(activity.event_key),
            eventType: String(activity.event_type),
            appCode: String(app.app_code ?? ''),
            occurredAt: String(activity.occurred_at),
            runningApps: (activity.running_apps as string[] | undefined) ?? null
          })
          recorded = true
        }
      }
      if (fault === 'drop') return void request.socket.destroy()
      return send(prior ? 200 : 201, {
        command_id: commandId,
        attempt_no: body?.attempt_no,
        status: body?.status,
        activity_recorded: recorded
      })
    }
    if (path === '/speech/syntheses' && request.method === 'POST') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const fault = this.ttsFaults.shift()
      if (typeof fault === 'number') return error(fault, 'UPSTREAM_ERROR')
      const text = String(body?.text ?? '').trim()
      if (text === '' || [...text].length > 300) return error(422, 'VALIDATION_ERROR')
      this.ttsTexts.push(text)
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' })
      return void response.end(
        Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0xff, 0xfb])
      )
    }
    if (path === '/recommendations/pending' && request.method === 'GET') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const offer = this.recommendation
      if (
        !offer ||
        this.recommendationAnswers.has(offer.recommendation_id) ||
        Date.parse(offer.expires_at) <= Date.now()
      )
        return send(204)
      return send(200, {
        recommendation_type: 'associated_app',
        reason_code: 'assoc_10min',
        algorithm_version: 'rule-v1',
        ...offer,
        expires_at: this.naiveTimes ? offer.expires_at.replace(/Z$/, '') : offer.expires_at
      })
    }
    const answerRoute = /^\/recommendations\/(\d+)\/responses$/.exec(path)
    if (answerRoute && request.method === 'POST') {
      if (!valid) return error(401, 'INVALID_SESSION')
      const id = Number(answerRoute[1])
      const fault = this.recommendationFaults.shift()
      if (typeof fault === 'number') return error(fault, 'FAULT')
      const offer = this.recommendation
      if (!offer || offer.recommendation_id !== id) return error(404, 'RESOURCE_NOT_FOUND')
      const answer = String(body?.response)
      if (!['approved', 'snoozed', 'rejected', 'dismissed'].includes(answer))
        return error(422, 'VALIDATION_ERROR')
      const prior = this.recommendationAnswers.get(id)
      if (prior !== undefined && prior !== answer)
        return error(409, 'RECOMMENDATION_ALREADY_RESPONDED')
      if (prior === undefined && Date.parse(offer.expires_at) <= Date.now())
        return error(410, 'RECOMMENDATION_EXPIRED')
      const created: { command_id: number; command_type: string }[] = []
      if (prior === undefined) {
        this.recommendationAnswers.set(id, answer)
        if (answer === 'approved')
          for (const target of offer.targets) {
            const command_id = 9000 + this.commands.length
            this.commands.push({
              command_id,
              attempt_no: 1,
              command_type: 'apps.launch',
              requested_app_code: target.app_code,
              arguments: {},
              requested_at: new Date().toISOString()
            })
            created.push({ command_id, command_type: 'apps.launch' })
          }
      }
      return send(200, { recommendation_id: id, response_status: answer, commands: created })
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
export async function startFakeServer(fake = new FakeJarvisServer()) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const bytes = Buffer.concat(chunks)
      fake.handle(request, response, bytes.toString('utf8'), bytes)
    })
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

/** The parts of a `multipart/form-data` body: text fields and files with their bytes. */
export function parseMultipart(
  bytes: Buffer,
  contentType: string
): { fields: Record<string, string>; files: { name: string; filename: string; bytes: Buffer }[] } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  const marker = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ''}`)
  const fields: Record<string, string> = {}
  const files: { name: string; filename: string; bytes: Buffer }[] = []
  let position = bytes.indexOf(marker)
  while (position >= 0) {
    const start = position + marker.length
    const next = bytes.indexOf(marker, start)
    if (next < 0) break
    // Skip the line break after the boundary, and the one before the next.
    const part = bytes.subarray(start + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, split).toString('utf8')
    const content = part.subarray(split + 4)
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? ''
    const filename = /filename="([^"]*)"/.exec(head)?.[1]
    if (filename !== undefined) files.push({ name, filename, bytes: Buffer.from(content) })
    else fields[name] = content.toString('utf8')
    position = next
  }
  return { fields, files }
}

/** Sample format and length of a 16-bit PCM WAV file, or null for anything the server refuses. */
export function wavFormat(bytes: Buffer): { seconds: number } | null {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null
  const compression = bytes.readUInt16LE(20)
  const channels = bytes.readUInt16LE(22)
  const rate = bytes.readUInt32LE(24)
  const bits = bytes.readUInt16LE(34)
  const dataBytes = bytes.readUInt32LE(40)
  if (compression !== 1 || channels !== 1 || rate !== 16_000 || bits !== 16) return null
  if (bytes.toString('ascii', 36, 40) !== 'data' || dataBytes > bytes.length - 44) return null
  return { seconds: dataBytes / 2 / rate }
}
