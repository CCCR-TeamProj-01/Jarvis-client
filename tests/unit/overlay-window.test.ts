import { describe, expect, it, vi } from 'vitest'
import { OverlayWindow } from '../../src/main/overlay/overlay-window'
import type { OverlayBrowserWindow } from '../../src/main/overlay/overlay-window'
import type { OverlayState } from '../../src/shared/contracts/overlay'
import { OVERLAY_CHANNELS } from '../../src/shared/ipc/channels'

const pill = (kind: 'listening' | 'speaking', stoppable = false) => ({
  id: `${kind}-1`,
  kind,
  text: '문구',
  stoppable
})
const shown = (voice: OverlayState['voice'], revision = 1): OverlayState => ({
  revision,
  voice,
  gesture: null
})
const EMPTY: OverlayState = { revision: 9, voice: null, gesture: null }

function setup(options: { loadFails?: boolean } = {}) {
  const log: string[] = []
  const sent: unknown[] = []
  let closed: () => void = () => undefined
  let resolveLoad: () => void = () => undefined
  const fake: OverlayBrowserWindow & { destroyed: boolean } = {
    destroyed: false,
    loadURL: vi.fn<OverlayBrowserWindow['loadURL']>(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveLoad = options.loadFails ? () => reject(new Error('x')) : resolve
        })
    ),
    isDestroyed: () => fake.destroyed,
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      log.push(`bounds ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`),
    showInactive: () => log.push('show'),
    hide: () => log.push('hide'),
    destroy: () => {
      fake.destroyed = true
      log.push('destroy')
    },
    setIgnoreMouseEvents: (ignore: boolean) => log.push(ignore ? 'passthrough' : 'interactive'),
    webContents: { send: (channel: string, state: unknown) => sent.push([channel, state]) },
    on: (_event: 'closed', listener: () => void) => {
      closed = listener
    }
  }
  const create = vi.fn<() => OverlayBrowserWindow>(() => fake)
  const displays = new Map<string | null, { x: number; y: number; width: number; height: number }>([
    [null, { x: 0, y: 0, width: 1440, height: 900 }],
    ['2', { x: -1920, y: 0, width: 1920, height: 1080 }]
  ])
  const overlay = new OverlayWindow({
    entryUrl: 'file:///overlay/index.html',
    create,
    displayBounds: (id) => displays.get(id) ?? displays.get(null)!
  })
  return { overlay, fake, create, log, sent, load: () => resolveLoad(), close: () => closed() }
}

describe('OverlayWindow', () => {
  it('creates no window until there is something to show', () => {
    const { overlay, create } = setup()
    overlay.apply(EMPTY, null)
    expect(create).not.toHaveBeenCalled()
  })

  it('opens passing the mouse through, and shows only after the page has loaded', async () => {
    const { overlay, create, log, load, fake } = setup()
    overlay.apply(shown(pill('listening')), null)
    expect(create).toHaveBeenCalledOnce()
    expect(fake.loadURL).toHaveBeenCalledWith('file:///overlay/index.html')
    expect(log).toContain('passthrough')
    expect(log).not.toContain('show')
    load()
    await Promise.resolve()
    await Promise.resolve()
    expect(log.at(-1)).toBe('show')
  })

  it('sends the state to the page and covers the display it was asked for', async () => {
    const { overlay, sent, log, load } = setup()
    overlay.apply(shown(pill('listening')), '2')
    load()
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toContain('bounds -1920,0 1920x1080')
    expect(sent.at(-1)).toEqual([OVERLAY_CHANNELS.state, shown(pill('listening'))])
    overlay.apply(shown(pill('listening'), 2), null)
    expect(log).toContain('bounds 0,0 1440x900')
  })

  it('serves the newest state to a page that asks', () => {
    const { overlay } = setup()
    expect(overlay.getState().voice).toBeNull()
    overlay.apply(shown(pill('listening')), null)
    expect(overlay.getState().voice?.kind).toBe('listening')
  })

  it('hides when there is nothing left to show, and shows again later without a new window', async () => {
    const { overlay, log, create, load } = setup()
    overlay.apply(shown(pill('listening')), null)
    load()
    await Promise.resolve()
    await Promise.resolve()
    overlay.apply(EMPTY, null)
    expect(log.at(-1)).toBe('hide')
    overlay.apply(shown(pill('listening'), 10), null)
    expect(log.at(-1)).toBe('show')
    expect(create).toHaveBeenCalledOnce()
  })

  it('takes the mouse only while a stop button is on screen', async () => {
    const { overlay, log, load } = setup()
    overlay.apply(shown(pill('listening')), null)
    load()
    await Promise.resolve()
    await Promise.resolve()
    overlay.setInteractive(true)
    expect(log.at(-1)).toBe('passthrough')
    overlay.apply(shown(pill('speaking', true), 2), null)
    expect(overlay.hasStoppable()).toBe(true)
    overlay.setInteractive(true)
    expect(log.at(-1)).toBe('interactive')
    overlay.setInteractive(false)
    expect(log.at(-1)).toBe('passthrough')
  })

  it('gives the mouse back to the desktop when the stop button goes away', async () => {
    const { overlay, log, load } = setup()
    overlay.apply(shown(pill('speaking', true)), null)
    load()
    await Promise.resolve()
    await Promise.resolve()
    overlay.setInteractive(true)
    overlay.apply(shown(pill('listening'), 2), null)
    expect(log.at(-1)).toMatch(/show|passthrough/)
    expect(log.lastIndexOf('passthrough')).toBeGreaterThan(log.lastIndexOf('interactive'))
  })

  it('ignores an interactive request when it has no window', () => {
    const { overlay, log } = setup()
    overlay.setInteractive(true)
    expect(log).toEqual([])
  })

  it('opens a fresh window after the old one was closed', () => {
    const { overlay, close, create } = setup()
    overlay.apply(shown(pill('listening')), null)
    close()
    overlay.apply(shown(pill('listening'), 2), null)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('forgets a window whose page could not be loaded', async () => {
    const { overlay, create, load } = setup({ loadFails: true })
    overlay.apply(shown(pill('listening')), null)
    load()
    await Promise.resolve()
    await Promise.resolve()
    overlay.apply(shown(pill('listening'), 2), null)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('destroys its window when disposed, and only once', () => {
    const { overlay, log } = setup()
    overlay.apply(shown(pill('listening')), null)
    overlay.dispose()
    overlay.dispose()
    expect(log.filter((line) => line === 'destroy')).toHaveLength(1)
  })
})
