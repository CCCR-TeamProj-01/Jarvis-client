import { describe, expect, it } from 'vitest'
import {
  acceleratorKeys,
  activeTab,
  appendMessage,
  conversationStatus,
  permissionLines,
  statusLines,
  voiceActive
} from '../../src/renderer/ui/view-model'
import type { Message } from '../../src/renderer/ui/view-model'
import type { SensorSnapshot } from '../../src/shared/contracts/sensors'
import { clientSnapshot } from '../fixtures/contracts'

const sensorState = (over: Partial<SensorSnapshot>): SensorSnapshot => ({
  kind: 'microphone',
  permission: 'granted',
  state: 'idle',
  leaseCount: 0,
  ...over
})

describe('activeTab', () => {
  it('shows the gesture and settings tabs when asked, and the conversation otherwise', () => {
    expect(activeTab({ screen: 'gesture' })).toBe('gesture')
    expect(activeTab({ screen: 'settings' })).toBe('settings')
    expect(activeTab({ screen: 'conversation' })).toBe('conversation')
    expect(activeTab({ screen: 'result' })).toBe('conversation')
    expect(activeTab({ screen: 'login' })).toBe('conversation')
  })
})

describe('appendMessage', () => {
  const event = (text: string, role: 'user' | 'assistant' | 'tool' = 'user') =>
    ({ type: 'result.available', requestId: 'r', role, text }) as const

  it('adds a line with its role and request', () => {
    expect(appendMessage([], event('안녕', 'assistant'), 7)).toEqual([
      { id: 7, requestId: 'r', role: 'assistant', text: '안녕' }
    ])
  })

  it('keeps only the most recent lines', () => {
    let log: Message[] = []
    for (let id = 0; id < 100; id++) log = appendMessage(log, event(`m${id}`), id)
    expect(log).toHaveLength(60)
    expect(log[0]?.text).toBe('m40')
    expect(log.at(-1)?.text).toBe('m99')
  })

  it('does not change the log it was given', () => {
    const before: Message[] = [{ id: 1, requestId: 'r', role: 'user', text: 'a' }]
    appendMessage(before, event('b'), 2)
    expect(before).toHaveLength(1)
  })
})

describe('statusLines', () => {
  const lines = (over: Parameters<typeof clientSnapshot>[0]) =>
    Object.fromEntries(statusLines(clientSnapshot(over)).map((line) => [line.id, line]))

  it('says everything is idle at rest', () => {
    const result = lines({})
    expect(result.microphone).toMatchObject({ value: '대기 중', tone: 'idle' })
    expect(result.gesture).toMatchObject({ value: '꺼짐', tone: 'idle' })
    expect(result.server).toMatchObject({ value: '연결 안 됨', tone: 'idle' })
  })

  it('shows the microphone in use, or what it needs', () => {
    expect(
      lines({ sensors: [sensorState({ state: 'active', leaseCount: 1 })] }).microphone
    ).toMatchObject({
      value: '사용 중',
      tone: 'ok'
    })
    expect(lines({ sensors: [sensorState({ permission: 'denied' })] }).microphone).toMatchObject({
      value: '권한이 필요해요',
      tone: 'warn'
    })
  })

  it('shows what gesture control is doing', () => {
    const gesture = (phase: 'tracking' | 'lost' | 'suspended', pointing = false) =>
      lines({
        gesture: {
          phase,
          generation: { sessionId: 'g', revision: 1 },
          activeHandId: null,
          displayId: '1',
          pointing
        }
      }).gesture
    expect(gesture('lost')).toMatchObject({ value: '손을 찾는 중', tone: 'info' })
    expect(gesture('tracking', true)).toMatchObject({ value: '켜짐 · 포인팅', tone: 'ok' })
    expect(gesture('tracking', false)).toMatchObject({ value: '켜짐 · 커서 멈춤', tone: 'ok' })
    expect(gesture('suspended')).toMatchObject({ value: '잠시 멈춤' })
  })

  it('shows the connection', () => {
    expect(lines({ connection: 'online' }).server).toMatchObject({ value: '연결됨', tone: 'ok' })
    expect(lines({ connection: 'connecting' }).server).toMatchObject({ value: '연결 중' })
  })

  it('shows microphone and gesture as paused while recognition is paused', () => {
    const result = lines({ recognitionPaused: true })
    expect(result.microphone.value).toBe('일시 중지')
    expect(result.gesture.value).toBe('일시 중지')
  })
})

describe('conversationStatus', () => {
  const status = (over: Parameters<typeof clientSnapshot>[0]) =>
    conversationStatus(clientSnapshot(over)).text

  it('follows the voice side', () => {
    const speech = (phase: string) =>
      status({ speech: { phase, generation: { sessionId: 's', revision: 1 } } as never })
    expect(speech('listening')).toBe('듣는 중')
    expect(speech('awaiting_followup')).toBe('듣는 중')
    expect(speech('transcribing')).toBe('처리 중')
    expect(speech('processing')).toBe('처리 중')
    expect(speech('speaking')).toBe('응답 중')
  })

  it('shows a typed request being worked on, a conversation in progress, and rest', () => {
    expect(status({ request: { requestId: 'r', phase: 'processing' } })).toBe('처리 중')
    expect(
      status({ conversation: { phase: 'active', generation: { sessionId: 'c', revision: 1 } } })
    ).toBe('대화 중')
    expect(status({})).toBe('대기 중')
  })

  it('shows a pause over everything else', () => {
    expect(
      status({ recognitionPaused: true, request: { requestId: 'r', phase: 'processing' } })
    ).toBe('인식 일시 중지')
  })

  it('knows when voice is in use', () => {
    expect(voiceActive(clientSnapshot({}))).toBe(false)
    expect(
      voiceActive(
        clientSnapshot({
          speech: { phase: 'listening', generation: { sessionId: 's', revision: 1 } }
        })
      )
    ).toBe(true)
  })
})

describe('permissionLines', () => {
  it('lists the microphone and the camera, and what to do when one is not allowed', () => {
    const lines = permissionLines(
      clientSnapshot({
        sensors: [
          sensorState({ permission: 'granted' }),
          sensorState({ kind: 'camera', permission: 'denied' })
        ]
      })
    )
    expect(lines.map((line) => line.label)).toEqual(['마이크', '카메라'])
    expect(lines[0]).toMatchObject({ value: '허용됨', tone: 'ok', hint: null })
    expect(lines[1]).toMatchObject({ value: '거부됨', tone: 'warn' })
    expect(lines[1]?.hint).toContain('시스템 설정')
  })

  it('treats a sensor that has not been used yet as not asked', () => {
    const lines = permissionLines(clientSnapshot({ sensors: [] }))
    expect(lines.every((line) => line.value === '아직 요청 전')).toBe(true)
  })

  it('names every permission state', () => {
    for (const permission of [
      'granted',
      'not_determined',
      'denied',
      'restricted',
      'unsupported'
    ] as const) {
      const [line] = permissionLines(clientSnapshot({ sensors: [sensorState({ permission })] }))
      expect(line?.value.length).toBeGreaterThan(0)
    }
  })
})

describe('acceleratorKeys', () => {
  it('writes the keys for the platform', () => {
    expect(acceleratorKeys('CommandOrControl+Shift+Space', 'darwin')).toEqual(['⌘', '⇧', 'Space'])
    expect(acceleratorKeys('CommandOrControl+Shift+G', 'win32')).toEqual(['Ctrl', 'Shift', 'G'])
    expect(acceleratorKeys('Alt+K', 'darwin')).toEqual(['⌥', 'K'])
    expect(acceleratorKeys('Alt+K', 'linux')).toEqual(['Alt', 'K'])
  })
})
