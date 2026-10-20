import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../src/main/conversation/conversation-manager'
import type { ConversationPolicy } from '../../src/main/conversation/conversation-manager'
import type {
  AssistantPort,
  AssistantReply,
  ConversationNotice,
  ConversationSnapshot
} from '../../src/main/conversation/ports'
import type { ClientError, Result } from '../../src/shared/contracts/common'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const reply = (over: Partial<AssistantReply> = {}): AssistantReply => ({
  text: '반가워요',
  ...over
})

interface Held<T> {
  promise: Promise<T>
  resolve(value: T): void
}
function hold<T>(): Held<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(policy: Partial<ConversationPolicy> = {}) {
  let gateError: ClientError | null = null
  const respond = vi.fn<AssistantPort['respond']>(async () => ({ ok: true, value: reply() }))
  const timers: { callback: () => void; cancelled: boolean; ms: number }[] = []
  let ids = 0
  const manager = new ConversationManager({
    gate: {
      check: () => (gateError ? { ok: false, error: gateError } : { ok: true, value: undefined })
    },
    assistant: { respond },
    clock: { now: () => 1000 },
    createId: () => `id-${++ids}`,
    schedule: (callback, ms) => {
      const timer = { callback, cancelled: false, ms }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    policy
  })
  const snapshots: ConversationSnapshot[] = []
  manager.subscribe((snapshot) => snapshots.push(snapshot))
  const notices: ConversationNotice[] = []
  manager.subscribeNotices((notice) => notices.push(notice))
  return {
    manager,
    respond,
    snapshots,
    notices,
    timers,
    closeGate: (error: ClientError) => {
      gateError = error
    },
    fire: (ms: number) =>
      timers.filter((t) => !t.cancelled && t.ms === ms).forEach((t) => t.callback()),
    pending: (ms: number) => timers.filter((t) => !t.cancelled && t.ms === ms).length
  }
}

describe('starting and ending', () => {
  it('starts one conversation and returns the same one again', () => {
    const t = setup()
    const first = t.manager.start()
    const second = t.manager.start()
    expect(first).toEqual({ ok: true, value: { conversationId: 'id-1' } })
    expect(second).toEqual(first)
    expect(t.manager.isActive()).toBe(true)
    expect(t.snapshots).toHaveLength(1)
    expect(t.snapshots[0]).toMatchObject({ phase: 'active', conversationId: 'id-1' })
  })

  it('does not start when signed out or paused', () => {
    const t = setup()
    t.closeGate({ code: 'authentication_required', message: '로그인이 필요합니다.' })
    expect(t.manager.start()).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(t.manager.isActive()).toBe(false)
    expect(t.snapshots).toEqual([])
  })

  it('ends on request, is safe to end again, and gives the next conversation a new identity', async () => {
    const t = setup()
    t.manager.start()
    expect(await t.manager.end()).toEqual({ ok: true, value: undefined })
    expect(await t.manager.end()).toEqual({ ok: true, value: undefined })
    expect(t.manager.getSnapshot()).toMatchObject({ phase: 'idle', conversationId: null })
    expect(t.manager.start()).toEqual({ ok: true, value: { conversationId: 'id-2' } })
  })

  it('keeps versions increasing across conversations', async () => {
    const t = setup()
    t.manager.start()
    await t.manager.end()
    t.manager.start()
    const versions = t.snapshots.map((s) => s.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })
})

describe('submitting what the user said or typed', () => {
  it('answers a typed message, starting the conversation if there is none', async () => {
    const t = setup()
    const result = await t.manager.submit({ text: '  안녕  ', modality: 'text' })
    expect(result).toEqual({ ok: true, value: { requestId: 'id-2', reply: reply() } })
    expect(t.respond).toHaveBeenCalledWith(
      { conversationId: 'id-1', requestId: 'id-2' },
      '안녕',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(t.notices).toEqual([
      { type: 'user', requestId: 'id-2', text: '안녕', modality: 'text' },
      { type: 'assistant', requestId: 'id-2', text: '반가워요' }
    ])
  })

  it('treats voice and typing alike and keeps them in one conversation', async () => {
    const t = setup()
    t.manager.start()
    await t.manager.submit({ text: '음성으로', modality: 'speech' })
    await t.manager.submit({ text: '글로', modality: 'text' })
    const conversations = new Set(t.respond.mock.calls.map(([turn]) => turn.conversationId))
    expect(conversations).toEqual(new Set(['id-1']))
    expect(t.notices.filter((n) => n.type === 'user').map((n) => n.modality)).toEqual([
      'speech',
      'text'
    ])
  })

  it('shows the request as being worked on, then idle again', async () => {
    const t = setup()
    const answer = hold<Result<AssistantReply>>()
    t.respond.mockReturnValueOnce(answer.promise)
    const pending = t.manager.submit({ text: '안녕', modality: 'text' })
    await flush()
    expect(t.manager.getSnapshot().request).toEqual({ requestId: 'id-2', phase: 'processing' })
    answer.resolve({ ok: true, value: reply() })
    await pending
    expect(t.manager.getSnapshot().request).toEqual({ requestId: null, phase: 'idle' })
  })

  it('refuses blank input without contacting the assistant', async () => {
    const t = setup()
    expect(await t.manager.submit({ text: '   ', modality: 'text' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(t.respond).not.toHaveBeenCalled()
    expect(t.manager.isActive()).toBe(false)
  })

  it('refuses a second request while one is being answered', async () => {
    const t = setup()
    const answer = hold<Result<AssistantReply>>()
    t.respond.mockReturnValueOnce(answer.promise)
    const first = t.manager.submit({ text: '첫째', modality: 'text' })
    await flush()
    expect(await t.manager.submit({ text: '둘째', modality: 'text' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' }
    })
    answer.resolve({ ok: true, value: reply() })
    await first
    expect(t.respond).toHaveBeenCalledOnce()
  })

  it('does not start a conversation for a submission when signed out', async () => {
    const t = setup()
    t.closeGate({ code: 'authentication_required', message: '로그인이 필요합니다.' })
    expect(await t.manager.submit({ text: '안녕', modality: 'text' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(t.respond).not.toHaveBeenCalled()
  })

  it('reports a failed answer to the user and keeps the conversation going', async () => {
    const t = setup()
    t.respond.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: '서버 오류' }
    })
    expect(await t.manager.submit({ text: '안녕', modality: 'text' })).toMatchObject({ ok: false })
    expect(t.notices.at(-1)).toEqual({
      type: 'problem',
      error: { code: 'unavailable', message: '서버 오류' }
    })
    expect(t.manager.isActive()).toBe(true)
    expect(t.manager.getSnapshot().request.phase).toBe('idle')
    expect(await t.manager.submit({ text: '다시', modality: 'text' })).toMatchObject({ ok: true })
  })

  it('times out a slow assistant', async () => {
    const t = setup({ responseTimeoutMs: 555 })
    t.respond.mockImplementationOnce(() => new Promise(() => undefined))
    const pending = t.manager.submit({ text: '안녕', modality: 'text' })
    await flush()
    t.fire(555)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'expired' } })
    expect(t.notices.at(-1)).toMatchObject({ type: 'problem', error: { code: 'expired' } })
    expect(t.manager.getSnapshot().request.phase).toBe('idle')
  })

  it('ends the conversation when the assistant says so, still returning the reply', async () => {
    const t = setup()
    t.respond.mockResolvedValueOnce({ ok: true, value: reply({ endConversation: true }) })
    const result = await t.manager.submit({ text: '그만', modality: 'speech' })
    expect(result).toMatchObject({ ok: true, value: { reply: { endConversation: true } } })
    expect(t.manager.isActive()).toBe(false)
    expect(t.notices.at(-1)).toMatchObject({ type: 'assistant' })
  })
})

describe('cancelling and late answers', () => {
  it('cancels the request in progress when the conversation ends and drops its answer', async () => {
    const t = setup()
    const answer = hold<Result<AssistantReply>>()
    let seen: AbortSignal | undefined
    t.respond.mockImplementationOnce((_turn, _text, options) => {
      seen = options?.signal
      return answer.promise
    })
    const pending = t.manager.submit({ text: '안녕', modality: 'text' })
    await flush()
    await t.manager.end()
    expect(seen?.aborted).toBe(true)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    answer.resolve({ ok: true, value: reply() })
    await flush()
    expect(t.notices.filter((n) => n.type === 'assistant')).toEqual([])
  })

  it('never lets an old answer reach a new conversation', async () => {
    const t = setup()
    const answer = hold<Result<AssistantReply>>()
    t.respond.mockReturnValueOnce(answer.promise)
    const old = t.manager.submit({ text: '옛 질문', modality: 'text' })
    await flush()
    await t.manager.end()
    t.manager.start()
    answer.resolve({ ok: true, value: reply({ text: '늦은 답' }) })
    expect(await old).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(t.notices.some((n) => n.type === 'assistant' && n.text === '늦은 답')).toBe(false)
    expect(t.manager.getSnapshot()).toMatchObject({ phase: 'active', request: { phase: 'idle' } })
  })

  it('honours a caller that cancels, and a signal that is already aborted', async () => {
    const t = setup()
    const controller = new AbortController()
    t.respond.mockImplementationOnce(() => new Promise(() => undefined))
    const pending = t.manager.submit(
      { text: '안녕', modality: 'speech' },
      { signal: controller.signal }
    )
    await flush()
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const aborted = new AbortController()
    aborted.abort()
    expect(
      await t.manager.submit({ text: '다시', modality: 'speech' }, { signal: aborted.signal })
    ).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})

describe('inactivity', () => {
  it('ends a conversation nobody is using after the idle time', () => {
    const t = setup({ idleTimeoutMs: 999 })
    t.manager.start()
    expect(t.pending(999)).toBe(1)
    t.fire(999)
    expect(t.manager.isActive()).toBe(false)
  })

  it('does not time out while a request is being answered or while held open', async () => {
    const t = setup({ idleTimeoutMs: 999 })
    t.manager.start()
    const release = t.manager.hold()
    expect(t.pending(999)).toBe(0)
    const answer = hold<Result<AssistantReply>>()
    t.respond.mockReturnValueOnce(answer.promise)
    const pending = t.manager.submit({ text: '안녕', modality: 'speech' })
    await flush()
    answer.resolve({ ok: true, value: reply() })
    await pending
    expect(t.pending(999)).toBe(0)
    release()
    release()
    expect(t.pending(999)).toBe(1)
  })

  it('restarts the idle clock on every request', async () => {
    const t = setup({ idleTimeoutMs: 999 })
    await t.manager.submit({ text: '안녕', modality: 'text' })
    expect(t.pending(999)).toBe(1)
    await t.manager.submit({ text: '또', modality: 'text' })
    expect(t.pending(999)).toBe(1)
  })

  it('holding a conversation that does not exist does nothing', () => {
    const t = setup()
    expect(() => t.manager.hold()()).not.toThrow()
  })
})
