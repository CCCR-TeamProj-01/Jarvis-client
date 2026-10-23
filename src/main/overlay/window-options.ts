import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * How the overlay window is built, apart from its page. Showing status must never take the
 * keyboard from whatever the user is working in, so the window cannot be focused.
 *
 * On macOS it is a panel. A normal window of this app cannot be drawn over another app's full-screen
 * Space (the window reports itself visible and nothing appears), while a panel is shown without
 * making this app the active one and can join that Space. `acceptFirstMouse` lets the first click on
 * a pill's stop button press it even though the app is not the active one.
 */
export function overlayWindowOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  return {
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    title: 'Jarvis Overlay',
    ...(platform === 'darwin' ? { type: 'panel' as const, acceptFirstMouse: true } : {})
  }
}
