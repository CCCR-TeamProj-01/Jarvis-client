import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { lockDownContents, secureWebPreferences } from '../../src/main/windows/secure-window'

describe('secureWebPreferences', () => {
  it('isolates the page, gives it no Node and sandboxes it', () => {
    expect(secureWebPreferences({ preload: '/app/ui.js' })).toEqual({
      preload: '/app/ui.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('keeps what a window sets for itself', () => {
    expect(
      secureWebPreferences({
        preload: '/app/media.js',
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'
      })
    ).toMatchObject({
      preload: '/app/media.js',
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    })
  })

  it('cannot be weakened, even by a caller that gets around the types', () => {
    const weakened = secureWebPreferences({
      preload: '/app/ui.js',
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false
    } as never)
    expect(weakened).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('does not change what it was given', () => {
    const own = { preload: '/app/ui.js', backgroundThrottling: false }
    secureWebPreferences(own)
    expect(own).toEqual({ preload: '/app/ui.js', backgroundThrottling: false })
  })
})

describe('lockDownContents', () => {
  function contents() {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>()
    const opener = vi.fn<(handler: (details: { url: string }) => { action: string }) => void>()
    return {
      handlers,
      opener,
      stand: {
        setWindowOpenHandler: opener,
        on: (event: string, handler: (event: { preventDefault(): void }) => void) => {
          handlers.set(event, handler)
        }
      }
    }
  }

  it('refuses every attempt to open another window', () => {
    const t = contents()
    lockDownContents(t.stand as never)
    const open = t.opener.mock.calls[0]![0]
    for (const url of ['https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', ''])
      expect(open({ url })).toEqual({ action: 'deny' })
  })

  it('stops the page from going anywhere else, by a link, a script or a redirect', () => {
    const t = contents()
    lockDownContents(t.stand as never)
    expect([...t.handlers.keys()].sort()).toEqual(['will-navigate', 'will-redirect'])
    for (const name of ['will-navigate', 'will-redirect']) {
      const event = { preventDefault: vi.fn<() => void>() }
      t.handlers.get(name)!(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })
})

describe('every window of the app', () => {
  function sourceFiles(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return /\.tsx?$/.test(entry.name) ? [path] : []
    })
  }
  const root = join(__dirname, '..', '..', 'src')
  const files = sourceFiles(root).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

  it('is built with the shared security settings and locked down, so a new window cannot leave them out', () => {
    const windows = files.filter((file) => file.text.includes('new BrowserWindow('))
    // The four windows that exist today; a new one only has to follow the same rule.
    expect(windows.length).toBeGreaterThanOrEqual(4)
    const lacking = windows
      .filter(
        (file) =>
          !file.text.includes('secureWebPreferences(') || !file.text.includes('lockDownContents(')
      )
      .map((file) => file.path.replace(root, 'src'))
    expect(lacking).toEqual([])
  })

  it('never switches one of the three protections off by hand', () => {
    const offenders = files
      .filter(
        (file) =>
          /nodeIntegration:\s*true/.test(file.text) ||
          /sandbox:\s*false/.test(file.text) ||
          /contextIsolation:\s*false/.test(file.text) ||
          /webSecurity:\s*false/.test(file.text)
      )
      .map((file) => file.path.replace(root, 'src'))
    expect(offenders).toEqual([])
  })

  it('does not write the protections out by hand in a window any more', () => {
    const handWritten = files
      .filter(
        (file) =>
          file.text.includes('new BrowserWindow(') &&
          /contextIsolation:\s*true/.test(file.text) &&
          !file.path.endsWith('secure-window.ts')
      )
      .map((file) => file.path.replace(root, 'src'))
    expect(handWritten).toEqual([])
  })
})
