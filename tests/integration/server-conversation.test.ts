import { afterEach, describe, expect, it } from 'vitest'
import { ConversationManager } from '../../src/main/conversation/conversation-manager'
import { ServerAssistant } from '../../src/main/conversation/server-assistant'
import { stopAllFakeServers } from '../fixtures/fake-auth-server'
import { signedInApp } from '../fixtures/signed-in-app'

afterEach(stopAllFakeServers)

/** The app's own conversation, answering through a real connection to the fake server. */
async function conversationApp() {
  const app = await signedInApp()
  const assistant = new ServerAssistant({
    client: app.api,
    // Waiting is shortened so the tests run fast; the order of calls is what is being checked.
    wait: (ms, signal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(ms, 15))
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      })
  })
  let ids = 0
  const conversation = new ConversationManager({
    gate: { check: () => ({ ok: true, value: undefined }) },
    assistant,
    clock: { now: () => performance.now() },
    createId: () => `local-${++ids}`,
    schedule: () => () => undefined
  })
  const say = (text: string) => conversation.submit({ text, modality: 'text' })
  return { ...app, assistant, conversation, say }
}

describe('typing to the server', () => {
  it('answers each input in one server conversation', async () => {
    const { say, fake } = await conversationApp()
    expect(await say('안녕하세요')).toMatchObject({
      ok: true,
      value: { reply: { text: 'echo: 안녕하세요' } }
    })
    expect(await say('두 번째')).toMatchObject({
      ok: true,
      value: { reply: { text: 'echo: 두 번째' } }
    })
    expect(fake.conversationsMade).toHaveLength(1)
    expect(fake.processed.map((item) => item.content)).toEqual(['안녕하세요', '두 번째'])
    expect(new Set(fake.processed.map((item) => item.requestId)).size).toBe(2)
    expect(fake.processed[0]!.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('renews an expiring token on the way and the conversation goes on', async () => {
    const { say, fake, clock } = await conversationApp()
    expect(await say('먼저')).toMatchObject({ ok: true })
    clock.nowMs += 3600 * 1000 - 30_000
    fake.calls.length = 0
    expect(await say('나중')).toMatchObject({ ok: true, value: { reply: { text: 'echo: 나중' } } })
    expect(fake.count('/auth/refresh')).toBe(1)
    expect(fake.conversationsMade).toHaveLength(1)
  })

  it('processes an input once even when the answer to the submit was lost', async () => {
    const { say, fake } = await conversationApp()
    fake.dropNextSubmitAnswer = true
    expect(await say('한 번만')).toMatchObject({
      ok: true,
      value: { reply: { text: 'echo: 한 번만' } }
    })
    expect(fake.processed).toHaveLength(1)
    expect(fake.calls.filter((call) => call.path.endsWith('/messages'))).toHaveLength(2)
  })

  it('waits out a request that is still running when the next one is submitted', async () => {
    const { assistant, fake } = await conversationApp()
    fake.processingMs = 60
    const stop = new AbortController()
    const first = assistant.respond({ conversationId: 'c', requestId: 'a' }, 'first', {
      signal: stop.signal
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop.abort()
    expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    // The server is still busy with the first one; the second waits for it, then goes through.
    const second = await assistant.respond({ conversationId: 'c', requestId: 'b' }, 'second')
    expect(second).toMatchObject({ ok: true, value: { text: 'echo: second' } })
    expect(fake.processed.map((item) => item.content)).toEqual(['first', 'second'])
  })

  it('reports a failed and a refused request in its own words', async () => {
    const { say, fake } = await conversationApp()
    fake.outcome = 'failed'
    const failed = await say('실패')
    expect(failed).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    fake.outcome = 'rejected'
    const refused = await say('거부')
    expect(refused).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    expect(JSON.stringify([failed, refused])).not.toContain('SERVER_DETAIL_THAT_MUST_NOT_SHOW')
  })

  it("shows the server's sentence when commands were planned, with no note about running them", async () => {
    const { say, fake } = await conversationApp()
    fake.withCommands = true
    expect(await say('크롬 열어줘')).toMatchObject({
      ok: true,
      value: { reply: { text: expect.not.stringContaining('아직 명령을 실행하지 않아요') } }
    })
  })

  it('ends the login when the server has ended the session', async () => {
    const { say, fake, manager } = await conversationApp()
    fake.endAllSessions()
    expect(await say('안녕')).toMatchObject({ ok: false, error: { code: 'session_expired' } })
    expect(manager.getSnapshot().phase).toBe('signed_out')
  })
})
