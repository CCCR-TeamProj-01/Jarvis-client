import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ fail: false, created: [] as unknown[] }))
vi.mock('electron', () => {
  class FakeTray {
    destroyed = false
    clicks: (() => void)[] = []
    constructor() {
      if (state.fail) throw new Error('no tray')
      state.created.push(this)
    }
    setToolTip = vi.fn<(tip: string) => void>()
    setContextMenu = vi.fn<(menu: unknown) => void>()
    on(_event: string, listener: () => void) {
      this.clicks.push(listener)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
  }
  return {
    Tray: FakeTray,
    Menu: { buildFromTemplate: vi.fn<(template: unknown) => unknown>((template) => template) }
  }
})
vi.mock('../../src/main/application/tray-icon', () => ({ createTrayIcon: () => ({}) }))

import { createAppTray, trayClickOpensWindow, trayMenu } from '../../src/main/application/tray'
import type { TrayActions } from '../../src/main/application/tray'

function actions() {
  const calls: string[] = []
  const value: TrayActions = {
    showWindow: () => calls.push('show'),
    startConversation: () => calls.push('start'),
    dispatch: (command) => calls.push(`dispatch ${command.type}`),
    quit: () => calls.push('quit')
  }
  return { value, calls }
}

beforeEach(() => {
  state.fail = false
  state.created = []
})

describe('trayMenu', () => {
  it('offers opening the window and starting a conversation as separate items', () => {
    const { value, calls } = actions()
    const menu = trayMenu(value)
    menu
      .find((item) => item.label === '자비스 열기')
      ?.click?.(undefined as never, undefined, undefined as never)
    menu
      .find((item) => item.label === '대화 시작')
      ?.click?.(undefined as never, undefined, undefined as never)
    expect(calls).toEqual(['show', 'start'])
  })

  it('turns the other items into the matching commands, and always has a way to quit', () => {
    const { value, calls } = actions()
    const menu = trayMenu(value)
    const press = (label: string) =>
      menu
        .find((item) => item.label === label)
        ?.click?.(undefined as never, undefined, undefined as never)
    for (const label of [
      '설정',
      '인식 일시 중지',
      '인식 재개',
      '제스처 시작',
      '제스처 중지',
      '앱 종료'
    ])
      press(label)
    expect(calls).toEqual([
      'dispatch settings.open',
      'dispatch recognition.pause',
      'dispatch recognition.resume',
      'dispatch gesture.start',
      'dispatch gesture.stop',
      'quit'
    ])
  })
})

describe('createAppTray', () => {
  it('on macOS a click does not open the window', () => {
    const { value } = actions()
    const tray = createAppTray(value, 'darwin') as unknown as { clicks: unknown[] }
    expect(tray.clicks).toHaveLength(0)
  })

  it('on Windows a click opens the window', () => {
    const { value, calls } = actions()
    const tray = createAppTray(value, 'win32') as unknown as { clicks: (() => void)[] }
    tray.clicks[0]?.()
    expect(calls).toEqual(['show'])
  })

  it('returns null when the system cannot make a tray', () => {
    state.fail = true
    expect(createAppTray(actions().value, 'win32')).toBeNull()
  })

  it('says by platform whether a click opens the window', () => {
    expect(trayClickOpensWindow('darwin')).toBe(false)
    expect(trayClickOpensWindow('win32')).toBe(true)
  })
})
