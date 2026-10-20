import { describe, expect, it } from 'vitest'
import { derivePersistent } from '../../src/main/overlay/derive-overlay'
import { OverlayController } from '../../src/main/overlay/overlay-controller'
import type { OverlayWindowPort } from '../../src/main/overlay/overlay-controller'
import type { OverlayState } from '../../src/shared/contracts/overlay'
import { OverlayStateSchema } from '../../src/shared/contracts/overlay'

describe('derivePersistent', () => {
  const idle = {
    speechPhase: 'idle',
    requestProcessing: false,
    gesture: { phase: 'off', pointing: false }
  } as const

  it('shows nothing while the app is idle', () => {
    expect(derivePersistent(idle)).toEqual({ voice: null, gesture: null })
  })

  it('follows every phase of the speech session', () => {
    const phases = [
      ['wake_detected', 'listening'],
      ['awaiting_speech', 'listening'],
      ['listening', 'listening'],
      ['transcribing', 'thinking'],
      ['processing', 'thinking'],
      ['speaking', 'speaking'],
      ['awaiting_followup', 'listening']
    ] as const
    for (const [speechPhase, kind] of phases)
      expect(derivePersistent({ ...idle, speechPhase }).voice).toMatchObject({ kind })
  })

  it('only the speaking pill has a stop button', () => {
    expect(derivePersistent({ ...idle, speechPhase: 'speaking' }).voice?.stoppable).toBe(true)
    expect(derivePersistent({ ...idle, speechPhase: 'listening' }).voice?.stoppable).toBe(false)
  })

  it('shows that a typed request is being worked on', () => {
    expect(derivePersistent({ ...idle, requestProcessing: true }).voice).toMatchObject({
      kind: 'thinking'
    })
  })

  it('the voice pill takes the speech phase over a plain request', () => {
    expect(
      derivePersistent({ ...idle, speechPhase: 'speaking', requestProcessing: true }).voice
    ).toMatchObject({ kind: 'speaking' })
  })

  it('follows the gesture mode', () => {
    const gesture = (phase: 'off' | 'tracking' | 'lost' | 'suspended', pointing = false) =>
      derivePersistent({ ...idle, gesture: { phase, pointing } }).gesture
    expect(gesture('off')).toBeNull()
    expect(gesture('lost')).toMatchObject({ kind: 'searching' })
    expect(gesture('tracking', true)).toMatchObject({ kind: 'pointing' })
    expect(gesture('tracking', false)).toMatchObject({ kind: 'holding' })
    expect(gesture('suspended')).toMatchObject({ kind: 'paused' })
  })
})

function setup(durations?: { done?: number; error?: number }) {
  const applied: { state: OverlayState; displayId: string | null }[] = []
  const window: OverlayWindowPort = {
    apply: (state, displayId) => applied.push({ state, displayId }),
    dispose: () => {
      disposed.count += 1
    }
  }
  const disposed = { count: 0 }
  const timers: { callback: () => void; ms: number; cancelled: boolean }[] = []
  const controller = new OverlayController({
    window,
    schedule: (callback, ms) => {
      const timer = { callback, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    durations
  })
  const client = (over: Partial<Parameters<OverlayController['setClientState']>[0]> = {}) =>
    controller.setClientState({
      speechPhase: 'idle',
      requestProcessing: false,
      gesture: { phase: 'off', pointing: false },
      recognitionPaused: false,
      ...over
    })
  /** Lets the newest timer that has not been cancelled run, as if its time had come. */
  const expire = (ms?: number) => {
    const timer = [...timers]
      .reverse()
      .find((t) => !t.cancelled && (ms === undefined || t.ms === ms))
    if (!timer) throw new Error('no timer')
    timer.cancelled = true
    timer.callback()
  }
  return { controller, applied, timers, client, expire, disposed }
}

describe('OverlayController', () => {
  it('shows nothing and sends nothing while idle', () => {
    const { client, applied } = setup()
    client()
    expect(applied).toEqual([])
  })

  it('shows what the speech session is doing, with a rising revision', () => {
    const { client, applied } = setup()
    client({ speechPhase: 'listening' })
    client({ speechPhase: 'processing' })
    client({ speechPhase: 'idle' })
    expect(applied.map((entry) => entry.state.voice?.kind ?? null)).toEqual([
      'listening',
      'thinking',
      null
    ])
    expect(applied.map((entry) => entry.state.revision)).toEqual([1, 2, 3])
    for (const entry of applied)
      expect(OverlayStateSchema.safeParse(entry.state).success).toBe(true)
  })

  it('does not send an update when nothing visible changed', () => {
    const { client, applied } = setup()
    client({ speechPhase: 'listening' })
    client({ speechPhase: 'listening', requestProcessing: true })
    expect(applied).toHaveLength(1)
  })

  it('keeps a pill’s ID while it looks the same and gives a new one when it changes', () => {
    const { client, controller } = setup()
    client({ speechPhase: 'listening' })
    const first = controller.getState().voice?.id
    client({ speechPhase: 'awaiting_speech' })
    const second = controller.getState().voice?.id
    client({ speechPhase: 'awaiting_speech', requestProcessing: true })
    expect(controller.getState().voice?.id).toBe(second)
    expect(second).not.toBe(first)
  })

  it('shows a result on top for a moment, then the state underneath again', () => {
    const { client, controller, expire, timers } = setup()
    client({ speechPhase: 'processing' })
    controller.toolResult(true, 'Safari을(를) 열었어요.')
    expect(controller.getState().voice).toMatchObject({
      kind: 'done',
      text: 'Safari을(를) 열었어요.'
    })
    expect(timers.at(-1)?.ms).toBe(2_500)
    expire()
    expect(controller.getState().voice).toMatchObject({ kind: 'thinking' })
  })

  it('shows a failed tool and an error for longer than a success', () => {
    const { controller, timers } = setup()
    controller.toolResult(false, '실행하지 못했어요.')
    expect(controller.getState().voice).toMatchObject({ kind: 'error' })
    expect(timers.at(-1)?.ms).toBe(5_000)
    controller.problem('서버에 연결하지 못했어요.')
    expect(timers.at(-1)?.ms).toBe(5_000)
  })

  it('a newer result replaces the earlier one and cancels its timer', () => {
    const { controller, timers } = setup()
    controller.toolResult(true, '하나')
    controller.toolResult(true, '둘')
    expect(timers[0]?.cancelled).toBe(true)
    expect(controller.getState().voice?.text).toBe('둘')
  })

  it('goes away completely once a result expires in an idle app', () => {
    const { controller, expire, applied } = setup()
    controller.toolResult(true, '완료')
    expire()
    expect(controller.getState().voice).toBeNull()
    expect(applied.at(-1)?.state).toMatchObject({ voice: null, gesture: null })
  })

  it('shortens very long text', () => {
    const { controller } = setup()
    controller.problem('가'.repeat(300))
    const text = controller.getState().voice?.text ?? ''
    expect(text.length).toBeLessThanOrEqual(60)
    expect(text.endsWith('…')).toBe(true)
  })

  it('follows the gesture mode and flashes a click', () => {
    const { client, controller, expire } = setup()
    client({ gesture: { phase: 'tracking', pointing: true, displayId: '2' } })
    expect(controller.getState().gesture).toMatchObject({ kind: 'pointing' })
    controller.click()
    expect(controller.getState().gesture).toMatchObject({ kind: 'clicking' })
    expire()
    expect(controller.getState().gesture).toMatchObject({ kind: 'pointing' })
    client({ gesture: { phase: 'off', pointing: false } })
    expect(controller.getState().gesture).toBeNull()
  })

  it('draws on the display the gesture is using', () => {
    const { client, applied } = setup()
    client({ gesture: { phase: 'lost', pointing: false, displayId: '7' } })
    expect(applied.at(-1)?.displayId).toBe('7')
    client({ gesture: { phase: 'lost', pointing: false } })
    client({ speechPhase: 'listening' })
    expect(applied.at(-1)?.displayId).toBeNull()
  })

  it('tells briefly that recognition was paused, only when it becomes paused', () => {
    const { client, controller, expire } = setup()
    client({ recognitionPaused: true })
    expect(controller.getState().voice).toMatchObject({ kind: 'paused' })
    expire()
    expect(controller.getState().voice).toBeNull()
    client({ recognitionPaused: true, speechPhase: 'idle' })
    expect(controller.getState().voice).toBeNull()
    client({ recognitionPaused: false })
    client({ recognitionPaused: true })
    expect(controller.getState().voice).toMatchObject({ kind: 'paused' })
  })

  it('stops showing anything after dispose and releases its window once', () => {
    const { controller, client, applied, disposed } = setup()
    controller.dispose()
    controller.dispose()
    client({ speechPhase: 'listening' })
    controller.problem('늦은 오류')
    expect(applied).toEqual([])
    expect(disposed.count).toBe(1)
  })
})
