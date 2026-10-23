import { describe, expect, it } from 'vitest'
import { overlayWindowOptions } from '../../src/main/overlay/window-options'

describe('overlayWindowOptions', () => {
  it('is a panel on macOS, so it can be shown over another app in full screen without activating', () => {
    expect(overlayWindowOptions('darwin')).toMatchObject({ type: 'panel', acceptFirstMouse: true })
  })

  it.each(['win32', 'linux'] as const)('is a plain window on %s', (platform) => {
    const options = overlayWindowOptions(platform)
    expect(options.type).toBeUndefined()
    expect(options.acceptFirstMouse).toBeUndefined()
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'never takes focus, the taskbar or a frame, and starts hidden on %s',
    (platform) => {
      expect(overlayWindowOptions(platform)).toMatchObject({
        show: false,
        focusable: false,
        skipTaskbar: true,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        movable: false,
        fullscreenable: false
      })
    }
  )

  it('leaves the web preferences to the caller, which must make them secure', () => {
    expect(overlayWindowOptions('darwin').webPreferences).toBeUndefined()
  })
})
