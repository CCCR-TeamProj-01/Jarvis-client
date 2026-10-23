import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationView } from '../../src/renderer/ui/features/conversation/conversation-view'
import { OUTCOME_VIEW, appendMessage } from '../../src/renderer/ui/view-model'
import type { Message } from '../../src/renderer/ui/view-model'
import { UiEventSchema } from '../../src/shared/contracts/interaction'
import type { UiEvent } from '../../src/shared/contracts/interaction'

type Line = Extract<UiEvent, { type: 'result.available' }>
const line = (overrides: Record<string, unknown> = {}) => ({
  type: 'result.available',
  requestId: 'cmd-1',
  role: 'tool',
  text: '계산기를 열었어요.',
  outcome: 'success',
  ...overrides
})

describe('a result line in the contract', () => {
  it('takes a tool line with each of the four outcomes', () => {
    for (const outcome of ['success', 'requested', 'unknown', 'failure'])
      expect(UiEventSchema.safeParse(line({ outcome })).success).toBe(true)
  })

  it('needs a tool line to say how it went', () => {
    const { outcome: _outcome, ...without } = line()
    expect(UiEventSchema.safeParse(without).success).toBe(false)
  })

  it('does not take an outcome on what the user or the assistant said', () => {
    for (const role of ['user', 'assistant'])
      expect(UiEventSchema.safeParse(line({ role, outcome: 'success' })).success).toBe(false)
    for (const role of ['user', 'assistant']) {
      const { outcome: _outcome, ...plain } = line({ role })
      expect(UiEventSchema.safeParse(plain).success).toBe(true)
    }
  })

  it('refuses an outcome it does not know', () => {
    for (const outcome of ['done', 'ok', 'error', '', null, 1, true])
      expect(UiEventSchema.safeParse(line({ outcome })).success).toBe(false)
  })

  it('refuses a field it does not know', () => {
    expect(UiEventSchema.safeParse(line({ ok: true })).success).toBe(false)
  })
})

describe('the log of lines', () => {
  const event = (overrides: Record<string, unknown> = {}) =>
    UiEventSchema.parse(line(overrides)) as Line

  it('keeps how a tool line went, and puts none on the others', () => {
    let log: Message[] = []
    log = appendMessage(log, event({ outcome: 'failure', text: '앱 전환에 실패했어요.' }), 1)
    log = appendMessage(
      log,
      UiEventSchema.parse({
        type: 'result.available',
        requestId: 'r',
        role: 'user',
        text: '안녕'
      }) as Line,
      2
    )
    expect(log[0]).toMatchObject({ role: 'tool', outcome: 'failure' })
    expect(log[1]).not.toHaveProperty('outcome')
  })

  it('keeps the lines that came while the window showed another tab', () => {
    let log: Message[] = []
    for (let id = 0; id < 5; id += 1)
      log = appendMessage(log, event({ requestId: `cmd-${id}` }), id)
    expect(log.map((entry) => entry.requestId)).toEqual([
      'cmd-0',
      'cmd-1',
      'cmd-2',
      'cmd-3',
      'cmd-4'
    ])
  })

  it('keeps only the most recent lines', () => {
    let log: Message[] = []
    for (let id = 0; id < 80; id += 1) log = appendMessage(log, event(), id)
    expect(log).toHaveLength(60)
    expect(log[0]!.id).toBe(20)
  })
})

describe('how an outcome is told', () => {
  it('says it in words, and gives each its own', () => {
    expect(Object.values(OUTCOME_VIEW).map((entry) => entry.label)).toEqual([
      '성공',
      '요청함',
      '확인 못 함',
      '실패'
    ])
    expect(new Set(Object.values(OUTCOME_VIEW).map((entry) => entry.tone)).size).toBe(4)
  })

  it('does not call a request that was handed over a success', () => {
    expect(OUTCOME_VIEW.requested.label).not.toBe(OUTCOME_VIEW.success.label)
    expect(OUTCOME_VIEW.unknown.label).not.toBe(OUTCOME_VIEW.success.label)
  })
})

describe('the conversation with results in it', () => {
  const render = (messages: Message[]) =>
    renderToStaticMarkup(
      createElement(ConversationView, {
        status: { text: '대기 중', tone: 'idle' },
        messages,
        paused: false,
        stoppable: false,
        callKeys: ['⌘', '⇧', 'Space'],
        onSubmitText: () => undefined,
        onStartVoice: () => undefined,
        onStop: () => undefined
      })
    )
  const tool = (id: number, outcome: Message['outcome'], text: string): Message => ({
    id,
    requestId: `cmd-${id}`,
    role: 'tool',
    text,
    ...(outcome ? { outcome } : {})
  })

  it('shows each result with its word and its words', () => {
    const html = render([
      tool(1, 'success', 'Google Chrome을(를) 열었어요.'),
      tool(2, 'requested', 'Google Chrome 실행을 요청했어요.'),
      tool(3, 'unknown', '볼륨을 바꿨는지 확인하지 못했어요.'),
      tool(4, 'failure', '앱 전환에 실패했어요. 앱이 실행 중이 아니라서 전환할 수 없습니다.')
    ])
    for (const word of ['성공', '요청함', '확인 못 함', '실패'])
      expect(html).toContain(`<small>${word}</small>`)
    expect(html).toContain('Google Chrome을(를) 열었어요.')
    expect(html).toContain('앱이 실행 중이 아니라서 전환할 수 없습니다.')
  })

  it('tells them apart by more than colour: each has its own word and icon', () => {
    const lines = ['success', 'requested', 'unknown', 'failure'] as const
    const html = lines.map((outcome) => render([tool(1, outcome, 'x')]))
    const words = html.map((markup) => /<small>([^<]+)<\/small>/.exec(markup)?.[1])
    expect(new Set(words).size).toBe(4)
    const classes = html.map((markup) => /msg-tool-(ok|info|warn|error)/.exec(markup)?.[1])
    expect(classes).toEqual(['ok', 'info', 'warn', 'error'])
    expect(new Set(html.map((markup) => /<svg[^>]*class="([^"]*)"/.exec(markup)?.[1])).size).toBe(4)
  })

  it('hides the icon from a screen reader, which has the word', () => {
    expect(render([tool(1, 'failure', 'x')])).toMatch(/aria-hidden="true"[^>]*><svg/)
  })

  it('does not call a result of unknown standing a success', () => {
    const html = render([tool(1, undefined, '결과가 있어요.')])
    expect(html).toContain('확인 못 함')
    expect(html).not.toContain('<small>성공</small>')
  })

  it('shows what the server or a tool said as text, never as markup', () => {
    const html = render([tool(1, 'failure', '<img src=x onerror=alert(1)>')])
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })

  it('shows lines from the user and the assistant as before', () => {
    const html = render([
      { id: 1, requestId: 'r', role: 'user', text: '계산기 켜줘' },
      { id: 2, requestId: 'r', role: 'assistant', text: 'PC 실행 명령을 보냈어요.' },
      tool(3, 'success', '계산기를 열었어요.')
    ])
    expect(html).toContain('msg-user')
    expect(html).toContain('msg-assistant')
    expect(html).toContain('msg-tool')
    expect(html.indexOf('계산기 켜줘')).toBeLessThan(html.indexOf('PC 실행 명령을 보냈어요.'))
    expect(html.indexOf('PC 실행 명령을 보냈어요.')).toBeLessThan(
      html.indexOf('계산기를 열었어요.')
    )
  })
})
