import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadDevEnv } from '../../src/main/application/dev-env'

describe('loadDevEnv with a stand-in reader', () => {
  const errnoError = (code: string, message = 'boom') => Object.assign(new Error(message), { code })

  it('reads the .env of the project folder in a development run', () => {
    const load = vi.fn<(path: string) => void>()
    expect(loadDevEnv({ isPackaged: false, root: '/work/jarvis', load })).toBe('loaded')
    expect(load).toHaveBeenCalledExactlyOnceWith(join('/work/jarvis', '.env'))
  })

  it('never reads it in a packaged app, even when the file is there', () => {
    const load = vi.fn<(path: string) => void>()
    expect(loadDevEnv({ isPackaged: true, root: '/work/jarvis', load })).toBe('skipped')
    expect(load).not.toHaveBeenCalled()
  })

  it('takes a missing file as the normal case, saying nothing', () => {
    const log = vi.fn<(message: string) => void>()
    const result = loadDevEnv({
      isPackaged: false,
      root: '/work/jarvis',
      load: () => {
        throw errnoError('ENOENT', "ENOENT: no such file '/work/jarvis/.env'")
      },
      log
    })
    expect(result).toBe('missing')
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ['no permission', errnoError('EACCES', "EACCES: permission denied, open '/work/jarvis/.env'")],
    [
      'a folder where the file should be',
      errnoError('EISDIR', 'EISDIR: illegal operation on a directory')
    ],
    ['an error with no code', new Error('SECRET_TOKEN=abc123 could not be parsed')]
  ])("reports %s in fixed words, without the error's text or the path", (_name, error) => {
    const log = vi.fn<(message: string) => void>()
    const result = loadDevEnv({
      isPackaged: false,
      root: '/work/jarvis',
      load: () => {
        throw error
      },
      log
    })
    expect(result).toBe('failed')
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '.env 파일을 읽지 못했어요. 형식과 권한을 확인해 주세요.'
    )
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|abc123|EACCES|\/work/)
  })

  it('does not fail on something thrown that is not an error', () => {
    const log = vi.fn<(message: string) => void>()
    const result = loadDevEnv({
      isPackaged: false,
      root: '/work/jarvis',
      load: () => {
        // eslint-disable-next-line no-throw-literal
        throw null
      },
      log
    })
    expect(result).toBe('failed')
  })
})

describe('loadDevEnv with the real reader', () => {
  const names = [
    'JARVIS_ENVTEST_PLAIN',
    'JARVIS_ENVTEST_QUOTED',
    'JARVIS_ENVTEST_JSON',
    'JARVIS_ENVTEST_FROM_SHELL',
    'JARVIS_ENVTEST_COMMENTED',
    'JARVIS_ENVTEST_INLINE'
  ]
  const folders: string[] = []
  afterEach(async () => {
    for (const name of names) delete process.env[name]
    await Promise.all(
      folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))
    )
  })

  async function project(contents: string | null): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), 'jarvis-env-'))
    folders.push(folder)
    if (contents !== null) await writeFile(join(folder, '.env'), contents, 'utf8')
    return folder
  }

  it("puts the file's values into the environment", async () => {
    const root = await project(
      [
        '# a comment',
        'JARVIS_ENVTEST_PLAIN=http://127.0.0.1:8001/api/v1',
        'JARVIS_ENVTEST_QUOTED="a value with spaces"',
        `JARVIS_ENVTEST_JSON='[{"tool":"apps.list","arguments":{}}]'`,
        '# JARVIS_ENVTEST_COMMENTED=1',
        'JARVIS_ENVTEST_INLINE=value # a note',
        ''
      ].join('\n')
    )
    expect(loadDevEnv({ isPackaged: false, root })).toBe('loaded')
    expect(process.env.JARVIS_ENVTEST_PLAIN).toBe('http://127.0.0.1:8001/api/v1')
    expect(process.env.JARVIS_ENVTEST_QUOTED).toBe('a value with spaces')
    expect(JSON.parse(process.env.JARVIS_ENVTEST_JSON ?? '')).toEqual([
      { tool: 'apps.list', arguments: {} }
    ])
    expect(process.env.JARVIS_ENVTEST_INLINE).toBe('value')
    // A line that is commented out sets nothing.
    expect(process.env.JARVIS_ENVTEST_COMMENTED).toBeUndefined()
  })

  it('leaves a value the shell already set alone', async () => {
    process.env.JARVIS_ENVTEST_FROM_SHELL = 'from the shell'
    const root = await project('JARVIS_ENVTEST_FROM_SHELL=from the file\nJARVIS_ENVTEST_PLAIN=x\n')
    loadDevEnv({ isPackaged: false, root })
    expect(process.env.JARVIS_ENVTEST_FROM_SHELL).toBe('from the shell')
    expect(process.env.JARVIS_ENVTEST_PLAIN).toBe('x')
  })

  it('does nothing, quietly, when there is no .env', async () => {
    const log = vi.fn<(message: string) => void>()
    const root = await project(null)
    expect(loadDevEnv({ isPackaged: false, root, log })).toBe('missing')
    expect(log).not.toHaveBeenCalled()
  })

  it('does not read the file in a packaged app', async () => {
    const root = await project('JARVIS_ENVTEST_PLAIN=should-not-appear\n')
    expect(loadDevEnv({ isPackaged: true, root })).toBe('skipped')
    expect(process.env.JARVIS_ENVTEST_PLAIN).toBeUndefined()
  })

  it('reports a .env that is a folder, in fixed words', async () => {
    const root = await project(null)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, '.env'))
    const log = vi.fn<(message: string) => void>()
    expect(loadDevEnv({ isPackaged: false, root, log })).toBe('failed')
    expect(log).toHaveBeenCalledTimes(1)
  })
})
