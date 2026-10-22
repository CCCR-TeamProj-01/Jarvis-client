import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkBuilt, validateReleaseServerUrl } from '../../scripts/check-server-url.mjs'
import { parseServerBaseUrl } from '../../src/main/connection/server-config'

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-server-url.mjs')
const NAME = 'MAIN_VITE_JARVIS_SERVER_URL'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'jarvis-url-'))
  folders.push(made)
  return made
}

/** Runs the script with a clean environment, so the real shell and `.env` cannot leak in. */
function run(args: string[], env: Record<string, string> = {}) {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '' }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...clean, ...env },
    encoding: 'utf8'
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

describe('validateReleaseServerUrl', () => {
  it('takes an https address and normalises it like the app does', () => {
    expect(validateReleaseServerUrl('https://api.example.com/api/v1/')).toEqual({
      ok: true,
      baseUrl: 'https://api.example.com/api/v1'
    })
    expect(validateReleaseServerUrl('https://api.example.com')).toEqual({
      ok: true,
      baseUrl: 'https://api.example.com'
    })
  })

  it.each([
    ['nothing', undefined],
    ['an empty value', ''],
    ['blanks', '   '],
    ['plain http', 'http://api.example.com/api/v1'],
    ['a made-up scheme', 'ftp://api.example.com'],
    ['not an address', 'api.example.com'],
    ['a password in it', 'https://user:pass@api.example.com'],
    ['a query', 'https://api.example.com/api/v1?x=1'],
    ['a fragment', 'https://api.example.com/api/v1#x'],
    ['surrounding space', ' https://api.example.com'],
    ['this machine', 'https://localhost:8001/api/v1'],
    ['this machine by number', 'https://127.0.0.1/api/v1'],
    ['this machine, v6', 'https://[::1]/api/v1'],
    ['any local address', 'https://0.0.0.0/api/v1'],
    ['a name under localhost', 'https://api.localhost/api/v1'],
    ['a number', 8001]
  ])('refuses %s', (_name, value) => {
    expect(validateReleaseServerUrl(value)).toMatchObject({ ok: false, reason: expect.any(String) })
  })

  it('never accepts what the installed app would then refuse', () => {
    const corpus = [
      'https://api.example.com/api/v1',
      'https://api.example.com/api/v1/',
      'https://api.example.com:8443/api/v1',
      'https://API.EXAMPLE.COM/api/v1',
      'https://api.example.com',
      'https://api.example.com//api//v1',
      'https://xn--9n2bp8q.example.com/api',
      'https://10.0.0.5/api/v1',
      'http://api.example.com/api/v1',
      'https://user@api.example.com',
      'https://api.example.com/?a=1',
      'https://api.example.com/#x',
      'ftp://api.example.com',
      'https://',
      '//api.example.com',
      '',
      ' https://api.example.com',
      'https://api.example.com ',
      'https://127.0.0.1/api/v1',
      'https://localhost/api/v1',
      'javascript:alert(1)'
    ]
    const accepted: string[] = []
    for (const raw of corpus) {
      const release = validateReleaseServerUrl(raw)
      const app = parseServerBaseUrl(raw, { httpsOnly: true })
      const same = release.ok && app.status === 'ready' && app.baseUrl === release.baseUrl
      if (release.ok && !same) accepted.push(raw)
    }
    // Whatever the release check accepts, the installed app accepts too, with the same address.
    expect(accepted).toEqual([])

    // And the other way round, apart from addresses on this machine, which only the release check refuses.
    const refused: string[] = []
    for (const raw of corpus) {
      const app = parseServerBaseUrl(raw, { httpsOnly: true })
      const local = /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(raw)
      const release = validateReleaseServerUrl(raw)
      const same = release.ok && app.status === 'ready' && app.baseUrl === release.baseUrl
      if (app.status === 'ready' && !local && !same) refused.push(raw)
    }
    expect(refused).toEqual([])
  })
})

describe('check-server-url before building', () => {
  it('stops, with a way out, when there is no address', async () => {
    const result = run(['--root', await folder()])
    expect(result.code).toBe(1)
    expect(result.err).toContain('패키징을 중단합니다')
    expect(result.err).toContain(NAME)
  })

  it.each([
    ['plain http', 'http://api.example.com/api/v1'],
    ['an address on this machine', 'https://localhost:8001/api/v1'],
    ['something that is not an address', 'not-a-url']
  ])('stops for %s', async (_name, value) => {
    const result = run(['--root', await folder()], { [NAME]: value })
    expect(result.code).toBe(1)
    expect(result.err).toContain('패키징을 중단합니다')
  })

  it('goes on with an https address from the shell', async () => {
    const result = run(['--root', await folder()], { [NAME]: 'https://api.example.com/api/v1/' })
    expect(result.code).toBe(0)
    expect(result.out).toContain('https://api.example.com/api/v1')
  })

  it('sees an address that is only in a .env file, as the build does', async () => {
    const root = await folder()
    await writeFile(join(root, '.env'), `${NAME}=https://from-file.example.com/api/v1\n`)
    const result = run(['--root', root])
    expect(result.code).toBe(0)
    expect(result.out).toContain('https://from-file.example.com/api/v1')
  })

  it('does not take the development variable for the build-time one', async () => {
    const result = run(['--root', await folder()], {
      JARVIS_SERVER_URL: 'https://api.example.com/api/v1'
    })
    expect(result.code).toBe(1)
  })

  it('does not print a value it refuses to use any more than it must', async () => {
    const result = run(['--root', await folder()], {
      [NAME]: 'https://user:s3cretpass@api.example.com'
    })
    expect(result.code).toBe(1)
    expect(result.err + result.out).not.toContain('s3cretpass')
  })
})

describe('check-server-url after building', () => {
  async function built(contents: Record<string, string>): Promise<string> {
    const out = await folder()
    await mkdir(join(out, 'main'), { recursive: true })
    for (const [name, text] of Object.entries(contents))
      await writeFile(join(out, 'main', name), text)
    return out
  }
  const address = 'https://api.example.com/api/v1'

  it('is satisfied when the address is in the app', async () => {
    const out = await built({ 'index.js': `const url = "${address}"\nstart(url)\n` })
    expect(await checkBuilt(out, address)).toEqual({ ok: true })
  })

  it('finds it in any file of the main bundle, including a nested one', async () => {
    const out = await built({ 'index.js': 'start()\n' })
    await mkdir(join(out, 'main', 'chunks'), { recursive: true })
    await writeFile(join(out, 'main', 'chunks', 'a.js'), `x("${address}")`)
    expect(await checkBuilt(out, address)).toEqual({ ok: true })
  })

  it('stops when the placeholder was left in the app', async () => {
    const out = await built({ 'index.js': `const url = import.meta.env.${NAME}\n` })
    expect(await checkBuilt(out, address)).toMatchObject({ ok: false })
  })

  it('stops when the placeholder is still there even though the address is in the app too', async () => {
    const out = await built({
      'index.js': `const a = "${address}"\nconst b = import.meta.env.${NAME}\n`
    })
    expect(await checkBuilt(out, address)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('자리표시자')
    })
  })

  it('stops when the address is not in the app, or another one is', async () => {
    const out = await built({ 'index.js': 'const url = "https://other.example.com/api/v1"\n' })
    expect(await checkBuilt(out, address)).toMatchObject({ ok: false })
    expect(await checkBuilt(await built({ 'index.js': 'void 0\n' }), address)).toMatchObject({
      ok: false
    })
  })

  it('stops when there is no build', async () => {
    expect(await checkBuilt(await folder(), address)).toMatchObject({ ok: false })
  })

  it('runs as the second step: needs both the address and a build that holds it', async () => {
    const root = await folder()
    const out = await built({ 'index.js': `x("${address}")` })
    const env = { [NAME]: address }
    expect(run(['--built', '--root', root, '--out', out], env).code).toBe(0)
    expect(
      run(['--built', '--root', root, '--out', await built({ 'index.js': 'x()' })], env).code
    ).toBe(1)
    expect(run(['--built', '--root', root, '--out', out]).code).toBe(1)
  })
})
