import { describe, expect, it, vi } from 'vitest'
import { GestureController } from '../../src/main/gesture/gesture-controller'
import type { HandTrackingSource } from '../../src/main/gesture/ports'
import type { InputExecutionOptions, PointerInputPort } from '../../src/main/platform/ports'
import type { ClientError, Generation, Result } from '../../src/shared/contracts/common'
import type {
  DesktopPoint,
  DisplayBounds,
  GestureSnapshot,
  HandObservation,
  HandTrackingEvent
} from '../../src/shared/contracts/gesture'
import { frame, hand } from '../fixtures/hands'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const display: DisplayBounds = {
  displayId: '1',
  x: 0,
  y: 0,
  width: 1001,
  height: 501,
  scaleFactor: 2
}
/** The middle of the part of the picture that spans the screen. */
const CENTER = { x: 0.5, y: 0.475 }
const OFFSET = 1_000 // the media renderer's clock runs 1 s behind Main's

type Call =
  | { kind: 'move'; point: DesktopPoint; options: InputExecutionOptions }
  | { kind: 'click'; options: InputExecutionOptions }

function setup(
  options: {
    activeHand?: 'left' | 'right' | 'auto_lock'
    gate?: Result<void>
    granted?: boolean
  } = {}
) {
  let now = 5_000
  const timers: { callback: () => void; at: number; cancelled: boolean }[] = []
  let sink: (event: HandTrackingEvent) => void = () => undefined
  const calls: Call[] = []
  const order: string[] = []
  const state = {
    granted: options.granted ?? true,
    gate: options.gate ?? ({ ok: true, value: undefined } as Result<void>),
    trackingStart: { ok: true, value: undefined } as Result<void>,
    holdTrackingStart: null as Promise<void> | null,
    pointerResult: null as Result<unknown> | null,
    holdMoves: null as Promise<void> | null
  }
  const requested = vi.fn<() => void>()
  const tracking: HandTrackingSource = {
    start: vi.fn<HandTrackingSource['start']>(async () => {
      order.push('tracking.start')
      if (state.holdTrackingStart) await state.holdTrackingStart
      return state.trackingStart
    }),
    stop: vi.fn<HandTrackingSource['stop']>(async () => {
      order.push('tracking.stop')
    }),
    subscribe: (listener) => {
      sink = listener
      return () => {
        sink = () => undefined
      }
    }
  }
  const pointer: PointerInputPort = {
    getDisplays: async () => ({ ok: true, value: [display] }),
    moveTo: async (point, execution) => {
      calls.push({ kind: 'move', point, options: execution })
      if (state.holdMoves) await state.holdMoves
      return (state.pointerResult as Result<never>) ?? { ok: true, value: { status: 'dispatched' } }
    },
    click: async (execution) => {
      calls.push({ kind: 'click', options: execution })
      return (state.pointerResult as Result<never>) ?? { ok: true, value: { status: 'dispatched' } }
    },
    releaseOwnedInputs: vi.fn<PointerInputPort['releaseOwnedInputs']>(async () => {
      order.push('pointer.release')
      return { ok: true, value: undefined } as const
    }),
    cancelGeneration: vi.fn<PointerInputPort['cancelGeneration']>(async () => {
      order.push('pointer.cancel')
      return { ok: true, value: undefined } as const
    })
  }
  const controller = new GestureController({
    tracking,
    pointer,
    permission: { isGranted: () => state.granted, request: requested },
    gate: { check: () => state.gate },
    clock: { now: () => now },
    schedule: (callback, delayMs) => {
      const timer = { callback, at: now + delayMs, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    createId: () => 'x'
  })
  const snapshots: GestureSnapshot[] = []
  const problems: ClientError[] = []
  controller.subscribe((snapshot) => snapshots.push(snapshot))
  controller.subscribeProblems((error) => problems.push(error))
  let generation: Generation | null = null
  const begin = async () => {
    const result = await controller.start({
      activeHand: options.activeHand ?? 'right',
      displayId: '1'
    })
    if (result.ok) generation = result.value
    return result
  }
  /** Delivers one frame whose capture time is `at` on the renderer's clock. */
  const send = async (
    sequence: number,
    at: number,
    hands: HandObservation[],
    extra: { generation?: Generation; lateByMs?: number } = {}
  ) => {
    now = at + OFFSET + 4_000 + (extra.lateByMs ?? 0)
    sink({
      type: 'tracking.frame',
      frame: frame(extra.generation ?? generation!, sequence, at, hands)
    })
    await flush()
  }
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers)
      if (!timer.cancelled && timer.at <= now) {
        timer.cancelled = true
        timer.callback()
      }
  }
  return {
    controller,
    tracking,
    pointer,
    calls,
    order,
    state,
    requested,
    snapshots,
    problems,
    begin,
    send,
    advance,
    emit: (event: HandTrackingEvent) => {
      sink(event)
      return flush()
    },
    generation: () => generation!,
    moves: () => calls.filter((call) => call.kind === 'move') as Extract<Call, { kind: 'move' }>[],
    clicks: () => calls.filter((call) => call.kind === 'click')
  }
}

describe('GestureController start and stop', () => {
  it('starts hand tracking under a new generation and waits for a hand', async () => {
    const t = setup()
    const result = await t.begin()
    expect(result).toMatchObject({ ok: true })
    expect(t.generation().sessionId).toBe('gesture-x')
    expect(t.tracking.start).toHaveBeenCalledWith(t.generation(), undefined)
    expect(t.controller.getSnapshot()).toEqual({
      phase: 'lost',
      generation: t.generation(),
      activeHandId: null,
      displayId: '1'
    })
  })

  it('does not start when signed out or paused', async () => {
    const t = setup({
      gate: { ok: false, error: { code: 'authentication_required', message: 'x' } }
    })
    expect(await t.begin()).toMatchObject({ ok: false, error: { code: 'authentication_required' } })
    expect(t.tracking.start).not.toHaveBeenCalled()
    expect(t.controller.getSnapshot().phase).toBe('off')
  })

  it('asks for the accessibility permission and does not start without it', async () => {
    const t = setup({ granted: false })
    const result = await t.begin()
    expect(result).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    expect(t.requested).toHaveBeenCalledOnce()
    expect(t.tracking.start).not.toHaveBeenCalled()
  })

  it('refuses a second start while running', async () => {
    const t = setup()
    await t.begin()
    expect(await t.begin()).toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('goes back to off, with nothing left running, when tracking cannot start', async () => {
    const t = setup()
    t.state.trackingStart = { ok: false, error: { code: 'unavailable', message: 'x' } }
    expect(await t.begin()).toMatchObject({ ok: false })
    expect(t.controller.getSnapshot().phase).toBe('off')
    expect(t.order).toContain('tracking.stop')
  })

  it('invalidates the generation before releasing input and the camera', async () => {
    const t = setup()
    await t.begin()
    t.order.length = 0
    await t.controller.stop()
    expect(t.controller.getSnapshot()).toEqual({
      phase: 'off',
      generation: null,
      activeHandId: null,
      displayId: null
    })
    expect(t.pointer.cancelGeneration).toHaveBeenCalledWith(t.generation())
    expect(t.order).toEqual(['pointer.cancel', 'pointer.release', 'tracking.stop'])
  })

  it('stopping while tracking is still starting cancels the start', async () => {
    const t = setup()
    let release: () => void = () => undefined
    t.state.holdTrackingStart = new Promise((resolve) => (release = resolve))
    const started = t.begin()
    await flush()
    await t.controller.stop()
    release()
    expect(await started).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(t.controller.getSnapshot().phase).toBe('off')
  })

  it('ignores everything that arrives after stop', async () => {
    const t = setup()
    await t.begin()
    const generation = t.generation()
    await t.controller.stop()
    await t.send(1, 0, [hand({ tip: CENTER })], { generation })
    expect(t.calls).toEqual([])
    expect(t.controller.getSnapshot().phase).toBe('off')
  })

  it('stopping when off is harmless', async () => {
    const t = setup()
    expect(await t.controller.stop()).toEqual({ ok: true, value: undefined })
  })

  it('can start again after stopping, as a new generation', async () => {
    const t = setup()
    await t.begin()
    const first = t.generation()
    await t.controller.stop()
    await t.begin()
    expect(t.generation()).toEqual(first) // same id source in this test, but a fresh session
    await t.send(1, 0, [hand({ tip: CENTER })])
    expect(t.moves()).toHaveLength(1)
  })
})

describe('GestureController cursor', () => {
  it('moves the cursor to where the hand points, mirrored, on the active display', async () => {
    const t = setup()
    await t.begin()
    await t.send(1, 0, [hand({ tip: CENTER })])
    expect(t.moves()[0]?.point.displayId).toBe('1')
    expect(t.moves()[0]?.point.x).toBeCloseTo(500, 0)
    expect(t.moves()[0]?.point.y).toBeCloseTo(250, 0)
    expect(t.controller.getSnapshot()).toMatchObject({ phase: 'tracking', activeHandId: 'right' })
  })

  it('moves right when the hand moves right in the user’s view (left in the picture)', async () => {
    const t = setup()
    await t.begin()
    await t.send(1, 0, [hand({ tip: { x: 0.6, y: 0.475 } })])
    const first = t.moves()[0]!.point.x
    for (let index = 1; index <= 10; index++)
      await t.send(1 + index, index * 33, [hand({ tip: { x: 0.4, y: 0.475 } })])
    expect(t.moves().at(-1)!.point.x).toBeGreaterThan(first)
  })

  it('gives each input an increasing sequence, the generation and a deadline', async () => {
    const t = setup()
    await t.begin()
    await t.send(1, 0, [hand({ tip: CENTER })])
    await t.send(2, 33, [hand({ tip: { x: 0.45, y: 0.475 } })])
    const sequences = t.calls.map((call) => call.options.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(new Set(sequences).size).toBe(sequences.length)
    for (const call of t.calls) {
      expect(call.options.generation).toEqual(t.generation())
      expect(call.options.deadlineMs).toBeGreaterThan(0)
    }
  })

  it('does not send movement smaller than the dead zone', async () => {
    const t = setup()
    await t.begin()
    await t.send(1, 0, [hand({ tip: CENTER })])
    await t.send(2, 33, [hand({ tip: { x: 0.5001, y: 0.475 } })])
    expect(t.moves()).toHaveLength(1)
  })

  it('keeps only the newest move while one is still being carried out', async () => {
    const t = setup()
    await t.begin()
    let release: () => void = () => undefined
    t.state.holdMoves = new Promise((resolve) => (release = resolve))
    for (let index = 0; index < 5; index++)
      await t.send(1 + index, index * 33, [hand({ tip: { x: 0.5 - index * 0.04, y: 0.475 } })])
    expect(t.moves()).toHaveLength(1)
    t.state.holdMoves = null
    release()
    await flush()
    await flush()
    expect(t.moves()).toHaveLength(2)
    expect(t.moves()[1]!.point.x).toBeGreaterThan(t.moves()[0]!.point.x)
  })

  it('only follows the configured hand', async () => {
    const t = setup({ activeHand: 'left' })
    await t.begin()
    await t.send(1, 0, [hand({ handId: 'right', handedness: 'right', tip: CENTER })])
    expect(t.moves()).toHaveLength(0)
    expect(t.controller.getSnapshot().phase).toBe('lost')
    await t.send(2, 33, [
      hand({ handId: 'right', handedness: 'right', tip: CENTER }),
      hand({ handId: 'left', handedness: 'left', tip: CENTER })
    ])
    expect(t.moves()).toHaveLength(1)
    expect(t.controller.getSnapshot().activeHandId).toBe('left')
  })

  it('auto_lock stays with the first hand even when the other is more confident', async () => {
    const t = setup({ activeHand: 'auto_lock' })
    await t.begin()
    await t.send(1, 0, [hand({ handId: 'right', confidence: 0.9, tip: CENTER })])
    await t.send(2, 33, [
      hand({ handId: 'right', confidence: 0.5, tip: CENTER }),
      hand({ handId: 'left', handedness: 'left', confidence: 0.99, tip: { x: 0.2, y: 0.2 } })
    ])
    expect(t.controller.getSnapshot().activeHandId).toBe('right')
  })

  it('drops frames from another generation and frames that are not newer', async () => {
    const t = setup()
    await t.begin()
    await t.send(5, 0, [hand({ tip: CENTER })])
    await t.send(5, 33, [hand({ tip: { x: 0.3, y: 0.3 } })])
    await t.send(4, 66, [hand({ tip: { x: 0.3, y: 0.3 } })])
    await t.send(6, 99, [hand({ tip: { x: 0.3, y: 0.3 } })], {
      generation: { sessionId: 'older', revision: 1 }
    })
    expect(t.moves()).toHaveLength(1)
  })

  it('discards a frame that waited too long instead of moving the cursor late', async () => {
    const t = setup()
    await t.begin()
    await t.send(1, 0, [hand({ tip: CENTER })])
    await t.send(2, 33, [hand({ tip: { x: 0.3, y: 0.3 } })], { lateByMs: 400 })
    expect(t.moves()).toHaveLength(1)
    await t.send(3, 66, [hand({ tip: { x: 0.3, y: 0.3 } })], { lateByMs: 20 })
    expect(t.moves()).toHaveLength(2)
  })
})

/** Frames at 33 ms spacing: `open` ones first, then the given ratios. */
async function approach(t: ReturnType<typeof setup>, ratios: number[], start = 1) {
  let sequence = start
  for (const ratio of ratios) {
    const x = 0.6 - sequence * 0.02
    await t.send(sequence, sequence * 33, [hand({ tip: { x, y: 0.475 }, pinch: ratio })])
    sequence += 1
  }
  return sequence
}

describe('GestureController pinch', () => {
  it('clicks where the cursor stands when the fingers snap together', async () => {
    const t = setup()
    await t.begin()
    const next = await approach(t, [1, 1, 1, 1, 1, 1, 1])
    expect(t.moves()).toHaveLength(7)
    const standing = t.moves()[6]!.point
    await approach(t, [0.2], next)
    expect(t.clicks()).toHaveLength(1)
    const click = t.calls.findIndex((call) => call.kind === 'click')
    const beforeClick = t.calls[click - 1] as Extract<Call, { kind: 'move' }>
    expect(beforeClick.kind).toBe('move')
    expect(beforeClick.point).toEqual(standing)
    expect(t.calls[click]!.options.sequence).toBeGreaterThan(beforeClick.options.sequence)
  })

  it('clicks where the cursor was a moment earlier when the fingers close too slowly to be noticed', async () => {
    const t = setup()
    await t.begin()
    // Closing by 0.02 a frame never falls by 0.12 within 150 ms, so the cursor keeps following.
    const frameAt = (sequence: number, pinch: number) =>
      t.send(sequence, sequence * 33, [
        hand({ tip: { x: 0.95 - sequence * 0.012, y: 0.475 }, pinch })
      ])
    // The number of moves sent once each frame had been handled.
    const sent: number[] = []
    let sequence = 1
    // The smoothing needs a few frames to get going; then every frame moves the cursor.
    for (; sequence <= 8; sequence++) {
      await frameAt(sequence, 1)
      sent[sequence] = t.moves().length
    }
    for (let ratio = 0.98; ratio > 0.255; ratio -= 0.02) {
      await frameAt(sequence, ratio)
      sent[sequence++] = t.moves().length
    }
    const warm = sent[8]!
    expect(t.moves()).toHaveLength(warm + (sequence - 9))
    expect(t.clicks()).toHaveLength(0)
    await frameAt(sequence, 0.24)
    expect(t.clicks()).toHaveLength(1)
    const click = t.calls.findIndex((call) => call.kind === 'click')
    const beforeClick = t.calls[click - 1] as Extract<Call, { kind: 'move' }>
    // The pinch frame is number `sequence`; the newest position 120 ms older is frame sequence - 4.
    expect(beforeClick.point).toEqual(t.moves()[sent[sequence - 4]! - 1]!.point)
    expect(beforeClick.point).not.toEqual(t.moves()[sent[sequence - 1]! - 1]!.point)
  })

  it('does not click again while the pinch is held, and not for a hand that only wobbles', async () => {
    const t = setup()
    await t.begin()
    let next = await approach(t, [1, 1, 1])
    next = await approach(t, [0.2, 0.1, 0.3, 0.4, 0.2, 0.3], next)
    expect(t.clicks()).toHaveLength(1)
    const moves = t.moves().length
    await approach(t, [0.2, 0.15], next)
    expect(t.moves()).toHaveLength(moves) // the cursor stays put during the pinch
  })

  it('clicks again after the fingers open and close again', async () => {
    const t = setup()
    await t.begin()
    let next = await approach(t, [1, 1, 0.2, 0.2])
    next = await approach(t, [0.9, 1], next)
    await approach(t, [0.2], next)
    expect(t.clicks()).toHaveLength(2)
  })

  it('does not click for a pinch that was already held when the hand appeared', async () => {
    const t = setup()
    await t.begin()
    const next = await approach(t, [0.2, 0.2, 0.2])
    expect(t.clicks()).toHaveLength(0)
    await approach(t, [0.9, 0.2], next)
    expect(t.clicks()).toHaveLength(1)
  })
})

describe('GestureController steadiness while pinching', () => {
  const at = (sequence: number, pinch: number) =>
    hand({
      // The knuckle keeps travelling; the fingertip does something else entirely.
      tip: { x: 0.7 - sequence * 0.02, y: 0.475 },
      fingertip: { x: 0.7 - sequence * 0.02 + (sequence % 2) * 0.1, y: 0.2 },
      pinch
    })

  it('follows the index knuckle, so a moving fingertip does not move the cursor', async () => {
    const t = setup()
    await t.begin()
    const still = (sequence: number) =>
      hand({ tip: CENTER, fingertip: { x: 0.4 + (sequence % 2) * 0.2, y: 0.2 } })
    for (let sequence = 1; sequence <= 6; sequence++)
      await t.send(sequence, sequence * 33, [still(sequence)])
    expect(t.moves()).toHaveLength(1)
  })

  it('holds the cursor as soon as the fingers start closing, and clicks exactly there', async () => {
    const t = setup()
    await t.begin()
    for (let sequence = 1; sequence <= 6; sequence++)
      await t.send(sequence, sequence * 33, [at(sequence, 1)])
    const moves = t.moves().length
    const resting = t.moves().at(-1)!.point
    // The fingers close over four frames while the hand drifts on.
    const ratios = [0.8, 0.6, 0.4, 0.2]
    for (const [index, ratio] of ratios.entries())
      await t.send(7 + index, (7 + index) * 33, [at(7 + index, ratio)])
    expect(t.clicks()).toHaveLength(1)
    const click = t.calls.findIndex((call) => call.kind === 'click')
    // Between the last move before closing and the click only the click's own move happened.
    expect(t.moves().length).toBeLessThanOrEqual(moves + 2)
    const clickMove = t.calls[click - 1] as Extract<Call, { kind: 'move' }>
    expect(clickMove.point.x).toBeGreaterThanOrEqual(resting.x - 0.001)
    expect(
      t
        .moves()
        .slice(moves)
        .every((move) => Math.abs(move.point.x - clickMove.point.x) < 40)
    ).toBe(true)
  })

  it('keeps the cursor still while the pinch is held and for a moment after it opens', async () => {
    const t = setup()
    await t.begin()
    let sequence = 1
    for (; sequence <= 4; sequence++) await t.send(sequence, sequence * 33, [at(sequence, 1)])
    for (const ratio of [0.5, 0.2, 0.2, 0.2]) {
      await t.send(sequence, sequence * 33, [at(sequence, ratio)])
      sequence += 1
    }
    const held = t.moves().length
    // Opening: the first frame ends the pinch; the next ones are inside the release hold.
    for (const ratio of [0.6, 0.9, 1]) {
      await t.send(sequence, sequence * 33, [at(sequence, ratio)])
      sequence += 1
    }
    expect(t.moves()).toHaveLength(held)
    // Well after the hold the cursor follows the hand again.
    for (let later = 0; later < 6; later++) {
      await t.send(sequence, sequence * 33, [at(sequence, 1)])
      sequence += 1
    }
    expect(t.moves().length).toBeGreaterThan(held)
  })

  it('does not mistake a hand that simply moves for fingers closing', async () => {
    const t = setup()
    await t.begin()
    for (let sequence = 1; sequence <= 8; sequence++)
      await t.send(sequence, sequence * 33, [at(sequence, 0.6 + (sequence % 2) * 0.05)])
    expect(t.moves()).toHaveLength(8)
    expect(t.clicks()).toHaveLength(0)
  })
})

describe('GestureController pointing pose', () => {
  const pose = (sequence: number, shape: 'pointing' | 'open' | 'fist', pinch = 1) =>
    hand({ tip: { x: 0.7 - sequence * 0.02, y: 0.475 }, pose: shape, pinch })

  it('moves only while pointing; the cursor stays put otherwise', async () => {
    const t = setup()
    await t.begin()
    for (let sequence = 1; sequence <= 12; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'open')])
    expect(t.moves()).toHaveLength(0)
    expect(t.controller.getSnapshot().phase).toBe('tracking')
    for (let sequence = 13; sequence <= 24; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'fist')])
    expect(t.moves()).toHaveLength(0)
    for (let sequence = 25; sequence <= 30; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'pointing')])
    expect(t.moves().length).toBeGreaterThan(0)
  })

  it('stops following soon after the hand leaves the pointing pose', async () => {
    const t = setup()
    await t.begin()
    for (let sequence = 1; sequence <= 10; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'pointing')])
    const moving = t.moves().length
    for (let sequence = 11; sequence <= 30; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'open')])
    // It kept following only for the short hold after the pose ended.
    expect(t.moves().length).toBeLessThan(moving + 8)
    const settled = t.moves().length
    for (let sequence = 31; sequence <= 40; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'open')])
    expect(t.moves()).toHaveLength(settled)
  })

  it('rides out a single frame where the pose is misread', async () => {
    const t = setup()
    await t.begin()
    for (let sequence = 1; sequence <= 10; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, sequence === 6 ? 'open' : 'pointing')])
    const afterMiss = t.moves().length
    await t.send(11, 11 * 33, [pose(11, 'pointing')])
    expect(t.moves().length).toBeGreaterThanOrEqual(afterMiss)
    expect(t.moves().length).toBeGreaterThan(6)
  })

  it('does not click for a pinch made outside the pointing pose', async () => {
    const t = setup()
    await t.begin()
    for (let sequence = 1; sequence <= 4; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'open', 1)])
    for (let sequence = 5; sequence <= 9; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'open', 0.2)])
    expect(t.clicks()).toHaveLength(0)
  })

  it('does not click when the hand turns to pointing while still pinched, only after opening', async () => {
    const t = setup()
    await t.begin()
    for (let sequence = 1; sequence <= 4; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'open', 1)])
    for (let sequence = 5; sequence <= 12; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'open', 0.2)])
    for (let sequence = 13; sequence <= 20; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'pointing', 0.2)])
    expect(t.clicks()).toHaveLength(0)
    await t.send(21, 21 * 33, [pose(21, 'pointing', 1)])
    await t.send(22, 22 * 33, [pose(22, 'pointing', 0.2)])
    expect(t.clicks()).toHaveLength(1)
  })

  it('still clicks when bending the index finger to meet the thumb makes it look less extended', async () => {
    const t = setup()
    await t.begin()
    const knuckle = { x: 0.5, y: 0.475 }
    for (let sequence = 1; sequence <= 8; sequence++)
      await t.send(sequence, sequence * 33, [hand({ tip: knuckle, pose: 'pointing', pinch: 1 })])
    // The fingertip curls towards the thumb: a short reach, as when pinching.
    const curl = [
      { pinch: 0.8, y: 0.3 },
      { pinch: 0.6, y: 0.35 },
      { pinch: 0.4, y: 0.4 },
      { pinch: 0.2, y: 0.45 }
    ]
    for (const [index, step] of curl.entries())
      await t.send(9 + index, (9 + index) * 33, [
        hand({
          tip: knuckle,
          fingertip: { x: 0.5, y: step.y },
          pose: 'pointing',
          pinch: step.pinch
        })
      ])
    expect(t.clicks()).toHaveLength(1)
  })

  it('keeps the cursor where it was when a pose is lost and jumps to the hand when pointing resumes', async () => {
    const t = setup()
    await t.begin()
    for (let sequence = 1; sequence <= 10; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'pointing')])
    for (let sequence = 11; sequence <= 20; sequence++)
      await t.send(sequence, sequence * 33, [pose(sequence, 'fist')])
    const before = t.moves().length
    const lastPoint = t.moves().at(-1)!.point
    for (let sequence = 40; sequence <= 46; sequence++)
      await t.send(sequence, sequence * 33, [hand({ tip: { x: 0.3, y: 0.475 }, pose: 'pointing' })])
    expect(t.moves().length).toBeGreaterThan(before)
    expect(t.moves().at(-1)!.point.x).not.toBe(lastPoint.x)
  })
})

describe('GestureController losing and regaining the hand', () => {
  it('stops input when the hand goes, and resumes without replaying anything', async () => {
    const t = setup()
    await t.begin()
    let next = await approach(t, [1, 1, 1])
    await t.send(next, next * 33, [])
    expect(t.controller.getSnapshot()).toMatchObject({ phase: 'lost', activeHandId: null })
    expect(t.pointer.releaseOwnedInputs).toHaveBeenCalled()
    const calls = t.calls.length
    await t.send(next + 1, (next + 1) * 33, [])
    expect(t.calls).toHaveLength(calls)

    // The hand returns holding a pinch: the cursor follows again but nothing is clicked.
    next += 2
    next = await approach(t, [0.2, 0.2], next)
    expect(t.controller.getSnapshot().phase).toBe('tracking')
    expect(t.calls.length).toBeGreaterThan(calls)
    expect(t.clicks()).toHaveLength(0)
    await approach(t, [1, 0.2], next)
    expect(t.clicks()).toHaveLength(1)
  })

  it('treats a camera that goes quiet as a lost hand', async () => {
    const t = setup()
    await t.begin()
    await approach(t, [1, 1])
    expect(t.controller.getSnapshot().phase).toBe('tracking')
    t.advance(700)
    expect(t.controller.getSnapshot().phase).toBe('lost')
    expect(t.pointer.releaseOwnedInputs).toHaveBeenCalled()
  })

  it('treats a no_hand or stale report as a lost hand but keeps the mode on', async () => {
    const t = setup()
    await t.begin()
    await approach(t, [1, 1])
    await t.emit({
      type: 'tracking.lost',
      generation: t.generation(),
      sequence: 3,
      reason: 'no_hand'
    })
    expect(t.controller.getSnapshot().phase).toBe('lost')
    await t.emit({
      type: 'tracking.lost',
      generation: t.generation(),
      sequence: 4,
      reason: 'stale'
    })
    expect(t.controller.getSnapshot().phase).toBe('lost')
    expect(t.problems).toEqual([])
  })

  it('lets another hand take over once the locked one has been gone for a while', async () => {
    const t = setup({ activeHand: 'auto_lock' })
    await t.begin()
    await t.send(1, 0, [hand({ handId: 'right', tip: CENTER })])
    const other = hand({ handId: 'left', handedness: 'left', tip: CENTER })
    await t.send(2, 33, [other])
    expect(t.controller.getSnapshot().phase).toBe('lost')
    await t.send(3, 800, [other])
    await t.send(4, 833, [other])
    expect(t.controller.getSnapshot()).toMatchObject({ phase: 'tracking', activeHandId: 'left' })
  })

  it('ends the mode and says why when the camera permission is revoked', async () => {
    const t = setup()
    await t.begin()
    await approach(t, [1])
    await t.emit({
      type: 'tracking.lost',
      generation: t.generation(),
      sequence: 2,
      reason: 'permission_revoked'
    })
    expect(t.controller.getSnapshot().phase).toBe('off')
    expect(t.problems).toEqual([expect.objectContaining({ code: 'permission_denied' })])
    expect(t.order).toContain('tracking.stop')
    expect(t.pointer.cancelGeneration).toHaveBeenCalled()
  })

  it('ends the mode when the hand engine stops', async () => {
    const t = setup()
    await t.begin()
    await t.emit({
      type: 'tracking.lost',
      generation: t.generation(),
      sequence: 2,
      reason: 'engine_error'
    })
    expect(t.controller.getSnapshot().phase).toBe('off')
    expect(t.problems).toHaveLength(1)
  })

  it('ignores a loss report from another generation', async () => {
    const t = setup()
    await t.begin()
    await approach(t, [1])
    await t.emit({
      type: 'tracking.lost',
      generation: { sessionId: 'older', revision: 1 },
      sequence: 9,
      reason: 'engine_error'
    })
    expect(t.controller.getSnapshot().phase).toBe('tracking')
  })
})

describe('GestureController when the OS refuses input', () => {
  it('ends the mode when the pointer reports a missing permission', async () => {
    const t = setup()
    await t.begin()
    t.state.pointerResult = { ok: false, error: { code: 'permission_denied', message: 'x' } }
    await approach(t, [1])
    await flush()
    expect(t.controller.getSnapshot().phase).toBe('off')
    expect(t.problems).toEqual([expect.objectContaining({ code: 'permission_denied' })])
  })

  it('carries on after an input that was merely late or superseded', async () => {
    const t = setup()
    await t.begin()
    t.state.pointerResult = { ok: false, error: { code: 'expired', message: 'x' } }
    await approach(t, [1])
    expect(t.controller.getSnapshot().phase).toBe('tracking')
    expect(t.problems).toEqual([])
  })

  it('ends the mode when the accessibility permission is withdrawn while running', async () => {
    const t = setup()
    await t.begin()
    await approach(t, [1])
    t.state.granted = false
    await t.send(10, 3_000, [hand({ tip: CENTER })])
    await flush()
    expect(t.controller.getSnapshot().phase).toBe('off')
    expect(t.problems[0]).toMatchObject({ code: 'permission_denied' })
  })
})
