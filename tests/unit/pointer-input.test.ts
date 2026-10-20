import { describe, expect, it, vi } from 'vitest'
import {
  createElectronDisplaySource,
  createFakePointerDriver,
  createLibnutDriver
} from '../../src/main/platform/libnut-driver'
import type { ElectronScreen } from '../../src/main/platform/libnut-driver'
import { PointerInput } from '../../src/main/platform/pointer-input'
import type { DisplaySource, PointerDriver } from '../../src/main/platform/pointer-input'
import type { InputExecutionOptions } from '../../src/main/platform/ports'
import type { DisplayBounds } from '../../src/shared/contracts/gesture'

const generation = { sessionId: 'gesture-1', revision: 1 }
const displays: DisplayBounds[] = [
  { displayId: '1', x: 0, y: 0, width: 1440, height: 900, scaleFactor: 2 },
  { displayId: '2', x: -1920, y: -100, width: 1920, height: 1080, scaleFactor: 1 }
]

function setup(now = 1000) {
  const calls: string[] = []
  const driver: PointerDriver = {
    moveTo: (point) => calls.push(`move ${point.x},${point.y}`),
    click: () => calls.push('click'),
    position: () => ({ x: 0, y: 0 })
  }
  const clock = { now: () => now }
  const source: DisplaySource = { list: () => displays }
  const input = new PointerInput({ driver, displays: source, clock })
  const options = (patch: Partial<InputExecutionOptions> = {}): InputExecutionOptions => ({
    generation,
    sequence: 1,
    deadlineMs: now + 100,
    ...patch
  })
  return { input, calls, options, driver }
}

describe('PointerInput', () => {
  it('lists displays and moves within one', async () => {
    const { input, calls, options } = setup()
    expect(await input.getDisplays()).toEqual({ ok: true, value: displays })
    const moved = await input.moveTo({ displayId: '2', x: -1000.4, y: 10 }, options())
    expect(moved).toEqual({
      ok: true,
      value: {
        status: 'dispatched',
        position: { displayId: '2', x: -1000.4, y: 10 }
      }
    })
    expect(calls).toEqual(['move -1000.4,10'])
  })

  it('keeps a point inside its display', async () => {
    const { input, calls, options } = setup()
    await input.moveTo({ displayId: '1', x: 5000, y: -20 }, options())
    expect(calls).toEqual(['move 1439,0'])
  })

  it('refuses an unknown display', async () => {
    const { input, calls, options } = setup()
    expect(await input.moveTo({ displayId: '9', x: 1, y: 1 }, options())).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    expect(calls).toEqual([])
  })

  it('reports a click as handed to the OS, not as having had an effect', async () => {
    const { input, calls, options } = setup()
    expect(await input.click(options())).toEqual({ ok: true, value: { status: 'dispatched' } })
    expect(calls).toEqual(['click'])
  })

  it('does not run an input past its deadline or after its signal was aborted', async () => {
    const { input, calls, options } = setup(1000)
    expect(await input.click(options({ deadlineMs: 1000 }))).toMatchObject({
      ok: false,
      error: { code: 'expired' }
    })
    const controller = new AbortController()
    controller.abort()
    expect(await input.click(options({ signal: controller.signal }))).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(calls).toEqual([])
  })

  it('drops inputs of a cancelled generation but not of another one', async () => {
    const { input, calls, options } = setup()
    await input.cancelGeneration(generation)
    expect(await input.click(options())).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const other = { sessionId: 'gesture-2', revision: 1 }
    expect((await input.click(options({ generation: other }))).ok).toBe(true)
    expect(calls).toEqual(['click'])
  })

  it('does not let an older input pull the pointer back after a newer one', async () => {
    const { input, calls, options } = setup()
    await input.moveTo({ displayId: '1', x: 10, y: 10 }, options({ sequence: 5 }))
    expect(
      await input.moveTo({ displayId: '1', x: 20, y: 20 }, options({ sequence: 4 }))
    ).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(
      await input.moveTo({ displayId: '1', x: 20, y: 20 }, options({ sequence: 5 }))
    ).toMatchObject({ ok: false })
    expect(
      (await input.moveTo({ displayId: '1', x: 30, y: 30 }, options({ sequence: 6 }))).ok
    ).toBe(true)
    expect(calls).toEqual(['move 10,10', 'move 30,30'])
  })

  it('reports a failing driver as a refusal, without throwing', async () => {
    const { input, driver, options } = setup()
    driver.moveTo = () => {
      throw new Error('native')
    }
    driver.click = () => {
      throw new Error('native')
    }
    expect(await input.moveTo({ displayId: '1', x: 1, y: 1 }, options())).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' }
    })
    expect(await input.click(options({ sequence: 2 }))).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' }
    })
  })

  it('has nothing of its own to release', async () => {
    const { input } = setup()
    expect(await input.releaseOwnedInputs()).toEqual({ ok: true, value: undefined })
  })

  it('reports missing displays as unavailable', async () => {
    const input = new PointerInput({
      driver: {
        moveTo: vi.fn<() => void>(),
        click: vi.fn<() => void>(),
        position: () => ({ x: 0, y: 0 })
      },
      displays: { list: () => [] },
      clock: { now: () => 0 }
    })
    expect(await input.getDisplays()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })
})

describe('Electron display source', () => {
  it('lists the primary display first and maps the fields', () => {
    const screen: ElectronScreen = {
      getPrimaryDisplay: () => ({ id: 22 }),
      getAllDisplays: () => [
        { id: 11, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        { id: 22, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }
      ]
    }
    expect(createElectronDisplaySource(screen).list()).toEqual([
      { displayId: '22', x: 0, y: 0, width: 1440, height: 900, scaleFactor: 2 },
      { displayId: '11', x: -1920, y: 0, width: 1920, height: 1080, scaleFactor: 1 }
    ])
  })
})

describe('libnut driver', () => {
  const fakeLibnut = () => {
    const calls: string[] = []
    return {
      calls,
      module: {
        moveMouse: (x: number, y: number) => calls.push(`move ${x},${y}`),
        mouseClick: (button?: string, double?: boolean) => calls.push(`click ${button} ${double}`),
        getMousePos: () => ({ x: 400, y: 200 }),
        setMouseDelay: (delay: number) => calls.push(`delay ${delay}`)
      }
    }
  }
  const screen: ElectronScreen = {
    getPrimaryDisplay: () => ({ id: 1 }),
    getAllDisplays: () => [],
    dipToScreenPoint: (point) => ({ x: point.x * 1.5, y: point.y * 1.5 }),
    screenToDipPoint: (point) => ({ x: point.x / 1.5, y: point.y / 1.5 })
  }

  it('uses the macOS module with logical points and no pointer delay', () => {
    const { calls, module } = fakeLibnut()
    const names: string[] = []
    const driver = createLibnutDriver(screen, 'darwin', (name) => {
      names.push(name)
      return module
    })
    driver.moveTo({ x: 10.4, y: 20.6 })
    driver.click()
    expect(names).toEqual(['@nut-tree-fork/libnut-darwin'])
    expect(calls).toEqual(['delay 0', 'move 10,21', 'click left false'])
    expect(driver.position()).toEqual({ x: 400, y: 200 })
  })

  it('converts through Electron’s DPI mapping on Windows', () => {
    const { calls, module } = fakeLibnut()
    const driver = createLibnutDriver(screen, 'win32', () => module)
    driver.moveTo({ x: 100, y: 100 })
    expect(calls).toContain('move 150,150')
    expect(driver.position().x).toBeCloseTo(266.67, 1)
  })

  it('refuses a platform without a pointer library', () => {
    expect(() => createLibnutDriver(screen, 'linux', () => fakeLibnut().module)).toThrow(
      'not supported'
    )
  })

  it('the development stand-in logs clicks always and moves rarely', () => {
    const lines: string[] = []
    let now = 1000
    const driver = createFakePointerDriver(
      (line) => lines.push(line),
      () => now
    )
    driver.moveTo({ x: 1, y: 2 })
    driver.moveTo({ x: 3, y: 4 })
    now += 300
    driver.moveTo({ x: 5, y: 6 })
    driver.click()
    expect(lines).toEqual([
      'POINTER_FAKE move 1 2',
      'POINTER_FAKE move 5 6',
      'POINTER_FAKE click 5 6'
    ])
    expect(driver.position()).toEqual({ x: 5, y: 6 })
  })
})
