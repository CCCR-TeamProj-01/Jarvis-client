import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn<(accelerator: string, handler: () => void) => boolean>(() => true),
    unregister: vi.fn<(accelerator: string) => void>()
  }
}))

import { globalShortcut } from 'electron'
import {
  DEFAULT_CALL_SHORTCUT,
  GESTURE_TOGGLE_SHORTCUT,
  registerShortcuts
} from '../../src/main/application/shortcuts'
import type { ShortcutSnapshot } from '../../src/shared/contracts/application'

beforeEach(() => {
  vi.mocked(globalShortcut.register).mockReset().mockReturnValue(true)
  vi.mocked(globalShortcut.unregister).mockReset()
})

function setup() {
  const call = vi.fn<() => void>()
  const toggleGesture = vi.fn<() => void>()
  const reports: ShortcutSnapshot[] = []
  const release = registerShortcuts({ call, toggleGesture, report: (state) => reports.push(state) })
  const handler = (accelerator: string) =>
    vi.mocked(globalShortcut.register).mock.calls.find(([a]) => a === accelerator)?.[1]
  return { call, toggleGesture, reports, release, handler }
}

describe('registerShortcuts', () => {
  it('registers the call and gesture shortcuts and wires them to their actions', () => {
    const { call, toggleGesture, handler, reports } = setup()
    handler(DEFAULT_CALL_SHORTCUT)?.()
    handler(GESTURE_TOGGLE_SHORTCUT)?.()
    expect(call).toHaveBeenCalledOnce()
    expect(toggleGesture).toHaveBeenCalledOnce()
    expect(reports).toEqual([{ status: 'registered', accelerator: DEFAULT_CALL_SHORTCUT }])
  })

  it('reports a taken call shortcut so the window can point to the tray', () => {
    vi.mocked(globalShortcut.register).mockImplementation(
      (accelerator) => accelerator !== DEFAULT_CALL_SHORTCUT
    )
    const { reports } = setup()
    expect(reports[0]).toMatchObject({ status: 'unavailable', error: { code: 'conflict' } })
  })

  it('treats a registration that throws as not registered', () => {
    vi.mocked(globalShortcut.register).mockImplementation(() => {
      throw new Error('denied')
    })
    const { reports, release } = setup()
    expect(reports[0]).toMatchObject({ status: 'unavailable' })
    release()
    expect(globalShortcut.unregister).not.toHaveBeenCalled()
  })

  it('gives back only what it registered, once', () => {
    vi.mocked(globalShortcut.register).mockImplementation(
      (accelerator) => accelerator === DEFAULT_CALL_SHORTCUT
    )
    const { release } = setup()
    release()
    release()
    expect(globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith(DEFAULT_CALL_SHORTCUT)
  })

  it('gives back the second shortcut even when releasing the first fails', () => {
    vi.mocked(globalShortcut.unregister).mockImplementationOnce(() => {
      throw new Error('release failed')
    })
    const { release } = setup()
    expect(() => release()).toThrow('release failed')
    expect(globalShortcut.unregister).toHaveBeenCalledWith(GESTURE_TOGGLE_SHORTCUT)
  })
})
