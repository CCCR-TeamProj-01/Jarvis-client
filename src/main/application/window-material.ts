import type { WindowMaterial } from '../../shared/contracts/application'

export const OPAQUE_WINDOW_BACKGROUND = '#f8fafc'

interface MaterialPreferences {
  readonly prefersReducedTransparency: boolean
  readonly shouldUseHighContrastColors: boolean
  readonly inForcedColorsMode: boolean
}

interface MaterialTheme extends MaterialPreferences {
  on(event: 'updated', listener: () => void): unknown
  off(event: 'updated', listener: () => void): unknown
}

interface MaterialWindow {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
  setVibrancy(type: 'under-window' | null): void
  setBackgroundMaterial(material: 'acrylic' | 'none'): void
}

export function supportsWindowsMaterial(release: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(release)
  if (!match) return false
  const [, major, minor, build] = match.map(Number)
  return major > 10 || (major === 10 && (minor > 0 || build >= 22621))
}

export function selectWindowMaterial(
  platform: NodeJS.Platform,
  release: string,
  preferences: MaterialPreferences
): WindowMaterial {
  if (
    preferences.prefersReducedTransparency ||
    preferences.shouldUseHighContrastColors ||
    preferences.inForcedColorsMode
  )
    return 'opaque'
  if (platform === 'darwin') return 'vibrancy'
  if (platform === 'win32' && supportsWindowsMaterial(release)) return 'acrylic'
  return 'opaque'
}

/** Owns only this window's nativeTheme listener; no OS preference is changed. */
export function watchWindowMaterial(
  window: MaterialWindow,
  theme: MaterialTheme,
  platform: NodeJS.Platform,
  release: string,
  onChange: (material: WindowMaterial) => void,
  enabled = true
): () => void {
  if (!enabled) {
    onChange('opaque')
    return () => undefined
  }
  let disposed = false
  let failed = false
  let applied: WindowMaterial | null = null
  const canUseWindowsMaterial = platform === 'win32' && supportsWindowsMaterial(release)

  const makeOpaque = () => {
    // Even if a native reset fails, Main reports opaque so Renderer paints a solid surface.
    const reset = [
      () => window.setBackgroundColor(OPAQUE_WINDOW_BACKGROUND),
      () => {
        if (platform === 'darwin') window.setVibrancy(null)
        else if (canUseWindowsMaterial) window.setBackgroundMaterial('none')
      }
    ]
    for (const operation of reset) {
      try {
        operation()
      } catch {
        /* Continue the independent fallback steps. */
      }
    }
  }

  const update = () => {
    if (disposed || window.isDestroyed()) return
    let material: WindowMaterial = 'opaque'
    try {
      if (!failed) material = selectWindowMaterial(platform, release, theme)
      if (material === applied) return
      if (material === 'opaque') makeOpaque()
      else {
        if (material === 'vibrancy') window.setVibrancy('under-window')
        else window.setBackgroundMaterial('acrylic')
        window.setBackgroundColor('#00000000')
      }
    } catch {
      failed = true
      material = 'opaque'
      makeOpaque()
    }
    applied = material
    onChange(material)
  }

  theme.on('updated', update)
  update()
  return () => {
    if (disposed) return
    disposed = true
    theme.off('updated', update)
  }
}
