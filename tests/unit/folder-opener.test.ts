import { describe, expect, it, vi } from 'vitest'
import { createFolderOpener } from '../../src/main/platform/folder-opener'
import type { FolderAlias } from '../../src/shared/contracts/tools'

const SECRET_PATH = '/Users/someone/Downloads'

function setup(
  overrides: {
    resolve?: (alias: FolderAlias) => string
    isDirectory?: (path: string) => Promise<boolean>
    openPath?: (path: string) => Promise<string>
  } = {}
) {
  const resolve = vi.fn<(alias: FolderAlias) => string>(overrides.resolve ?? (() => SECRET_PATH))
  const isDirectory = vi.fn<(path: string) => Promise<boolean>>(
    overrides.isDirectory ?? (async () => true)
  )
  const openPath = vi.fn<(path: string) => Promise<string>>(overrides.openPath ?? (async () => ''))
  return { opener: createFolderOpener({ resolve, isDirectory, openPath }), resolve, openPath }
}

describe('folder opener', () => {
  it('resolves the alias in Main, hands the folder over and reports only the alias', async () => {
    const { opener, resolve, openPath } = setup()
    const result = await opener.open('downloads')
    expect(resolve).toHaveBeenCalledWith('downloads')
    expect(openPath).toHaveBeenCalledWith(SECRET_PATH)
    expect(result).toEqual({
      ok: true,
      value: { kind: 'folder', alias: 'downloads', status: 'dispatched' }
    })
    expect(JSON.stringify(result)).not.toContain('Users')
  })

  it('rejects anything that is not a known alias without touching the OS', async () => {
    const { opener, resolve, openPath } = setup()
    for (const alias of ['/etc', '..', 'Downloads', '', 'trash'])
      expect(await opener.open(alias as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' }
      })
    expect(resolve).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports a missing folder as not found, without the path', async () => {
    for (const setupOptions of [
      { isDirectory: async () => false },
      { isDirectory: async () => Promise.reject(new Error(`ENOENT ${SECRET_PATH}`)) },
      {
        resolve: () => {
          throw new Error(`no such folder ${SECRET_PATH}`)
        }
      }
    ]) {
      const { opener, openPath } = setup(setupOptions)
      const result = await opener.open('music')
      expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } })
      expect(JSON.stringify(result)).not.toContain('Users')
      expect(openPath).not.toHaveBeenCalled()
    }
  })

  it('reports a failed handoff as unavailable and keeps the OS message and path out of it', async () => {
    for (const openPath of [
      async () => `Failed to open ${SECRET_PATH}`,
      async () => Promise.reject(new Error(SECRET_PATH))
    ]) {
      const result = await setup({ openPath }).opener.open('documents')
      expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
      expect(JSON.stringify(result)).not.toContain('Users')
    }
  })

  it('does not open anything for a request cancelled before or during the check', async () => {
    const early = new AbortController()
    early.abort()
    const first = setup()
    expect(await first.opener.open('desktop', { signal: early.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(first.resolve).not.toHaveBeenCalled()

    const late = new AbortController()
    const second = setup({
      isDirectory: async () => {
        late.abort()
        return true
      }
    })
    expect(await second.opener.open('desktop', { signal: late.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' }
    })
    expect(second.openPath).not.toHaveBeenCalled()
  })
})
