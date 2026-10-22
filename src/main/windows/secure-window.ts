import type { WebContents, WebPreferences } from 'electron'

/** What a window may set for itself. The three that keep the page contained are not among them. */
type OwnPreferences = Omit<WebPreferences, 'contextIsolation' | 'nodeIntegration' | 'sandbox'> & {
  /** Every window loads its own bridge; there is no window without one. */
  preload: string
}

/**
 * The web preferences of every window of the app. A page runs isolated from the preload, with no
 * Node, in a sandbox. The three are applied last, so a window can add what is its own (the preload,
 * how it is throttled) but cannot weaken them.
 */
export function secureWebPreferences(own: OwnPreferences): WebPreferences {
  return { ...own, contextIsolation: true, nodeIntegration: false, sandbox: true }
}

/**
 * Keeps a window on the page Main loaded into it: it opens no new windows and goes nowhere else,
 * whether by a link, a script or a redirect.
 */
export function lockDownContents(contents: Pick<WebContents, 'setWindowOpenHandler' | 'on'>): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-redirect', (event) => event.preventDefault())
}
