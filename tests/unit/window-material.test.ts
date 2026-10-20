import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  OPAQUE_WINDOW_BACKGROUND,
  selectWindowMaterial,
  watchWindowMaterial
} from '../../src/main/application/window-material'

function setup(platform: NodeJS.Platform = 'darwin', release = '24.0.0') {
  const window = {
    isDestroyed: vi.fn<() => boolean>(() => false),
    setBackgroundColor: vi.fn<(color: string) => void>(),
    setVibrancy: vi.fn<(type: 'under-window' | null) => void>(),
    setBackgroundMaterial: vi.fn<(material: 'acrylic' | 'none') => void>()
  }
  const theme = Object.assign(new EventEmitter(), {
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
    inForcedColorsMode: false
  })
  const onChange = vi.fn<(material: string) => void>()
  const start = () => watchWindowMaterial(window, theme, platform, release, onChange)
  return { window, theme, onChange, start }
}

describe('native window material selection and lifecycle', () => {
  it('does not touch native effects or subscribe when explicitly disabled', () => {
    const { window, theme, onChange } = setup()
    const dispose = watchWindowMaterial(window, theme, 'darwin', '24.0.0', onChange, false)
    expect(onChange).toHaveBeenCalledExactlyOnceWith('opaque')
    expect(window.setVibrancy).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
    expect(theme.listenerCount('updated')).toBe(0)
    dispose()
  })
  it.each([
    ['darwin', '24.0.0', 'vibrancy'],
    ['win32', '10.0.19045', 'opaque'],
    ['win32', '10.0.22000', 'opaque'],
    ['win32', '10.0.22620', 'opaque'],
    ['win32', '10.0.22621', 'acrylic'],
    ['win32', '10.0.26100.1', 'acrylic'],
    ['win32', 'unknown', 'opaque'],
    ['win32', '10.0.22621.preview', 'opaque'],
    ['linux', '6.8.0', 'opaque']
  ] as const)('uses %s / %s → %s', (platform, release, expected) => {
    const { theme } = setup()
    expect(selectWindowMaterial(platform, release, theme)).toBe(expected)
  })

  it.each([
    'prefersReducedTransparency',
    'shouldUseHighContrastColors',
    'inForcedColorsMode'
  ] as const)('removes and restores the material when %s changes', (preference) => {
    const { window, theme, onChange, start } = setup()
    const dispose = start()
    expect(window.setVibrancy).toHaveBeenCalledWith('under-window')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    theme[preference] = true
    theme.emit('updated')
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(OPAQUE_WINDOW_BACKGROUND)
    expect(onChange).toHaveBeenLastCalledWith('opaque')
    theme[preference] = false
    theme.emit('updated')
    expect(window.setVibrancy).toHaveBeenLastCalledWith('under-window')
    expect(onChange).toHaveBeenLastCalledWith('vibrancy')
    dispose()
  })

  it('applies and removes Windows Acrylic without calling macOS APIs', () => {
    const { window, theme, onChange, start } = setup('win32', '10.0.22621')
    const dispose = start()
    expect(window.setBackgroundMaterial).toHaveBeenCalledWith('acrylic')
    expect(onChange).toHaveBeenLastCalledWith('acrylic')
    theme.prefersReducedTransparency = true
    theme.emit('updated')
    expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith('none')
    expect(onChange).toHaveBeenLastCalledWith('opaque')
    expect(window.setVibrancy).not.toHaveBeenCalled()
    dispose()
  })

  it('does not call unsupported native APIs on Windows 10', () => {
    const { window, onChange, start } = setup('win32', '10.0.19045')
    const dispose = start()
    expect(window.setVibrancy).not.toHaveBeenCalled()
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled()
    expect(window.setBackgroundColor).toHaveBeenCalledWith(OPAQUE_WINDOW_BACKGROUND)
    expect(onChange).toHaveBeenCalledExactlyOnceWith('opaque')
    dispose()
  })

  it.each(['darwin', 'win32'] as const)(
    'falls back after %s failure and does not retry on every theme event',
    (platform) => {
      const { window, theme, onChange, start } = setup(platform, '10.0.22621')
      const fail = () => {
        throw new Error('Native compositor unavailable')
      }
      if (platform === 'darwin') window.setVibrancy.mockImplementationOnce(fail)
      else window.setBackgroundMaterial.mockImplementationOnce(fail)
      const dispose = start()
      expect(window.setBackgroundColor).toHaveBeenLastCalledWith(OPAQUE_WINDOW_BACKGROUND)
      expect(onChange).toHaveBeenCalledExactlyOnceWith('opaque')
      const calls =
        window.setVibrancy.mock.calls.length + window.setBackgroundMaterial.mock.calls.length
      theme.emit('updated')
      expect(
        window.setVibrancy.mock.calls.length + window.setBackgroundMaterial.mock.calls.length
      ).toBe(calls)
      dispose()
    }
  )

  it('uses the Renderer opaque fallback even when resetting a native material fails', () => {
    const { window, theme, onChange, start } = setup()
    const dispose = start()
    window.setVibrancy.mockImplementationOnce(() => {
      throw new Error('Reset failed')
    })
    theme.prefersReducedTransparency = true
    theme.emit('updated')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(OPAQUE_WINDOW_BACKGROUND)
    expect(onChange).toHaveBeenLastCalledWith('opaque')
    dispose()
  })

  it('keeps other windows subscribed, ignores unchanged events and disposes idempotently', () => {
    const { window, theme, onChange, start } = setup()
    const other = vi.fn<() => void>()
    theme.on('updated', other)
    const dispose = start()
    theme.emit('updated')
    expect(onChange).toHaveBeenCalledOnce()
    dispose()
    dispose()
    theme.prefersReducedTransparency = true
    theme.emit('updated')
    expect(theme.listenerCount('updated')).toBe(1)
    expect(other).toHaveBeenCalledTimes(2)
    expect(window.setVibrancy).toHaveBeenCalledOnce()
  })

  it('does not touch a destroyed window', () => {
    const { window, theme, onChange, start } = setup()
    const dispose = start()
    window.isDestroyed.mockReturnValue(true)
    theme.prefersReducedTransparency = true
    theme.emit('updated')
    expect(onChange).toHaveBeenCalledOnce()
    expect(window.setVibrancy).toHaveBeenCalledOnce()
    dispose()
  })
})
