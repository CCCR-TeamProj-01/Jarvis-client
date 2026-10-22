// Keeps a build that cannot reach a server from being packaged. An installed app uses only the
// address that was put into it when it was built (`MAIN_VITE_JARVIS_SERVER_URL`), so a package made
// without one, or with an address the app would refuse, would never connect to anything.
//
//   node scripts/check-server-url.mjs                 before building: is the address usable?
//   node scripts/check-server-url.mjs --built         after building: did it really get into the app?
//
// Options (for tests): --root <folder with the .env files>, --out <folder of the built app>.
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'

const NAME = 'MAIN_VITE_JARVIS_SERVER_URL'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/**
 * Whether an installed app would accept this address, and for a release also that it is not a
 * server on the machine that builds it. It mirrors the app's own rule for an installed app
 * (`parseServerBaseUrl` with `httpsOnly`); a test keeps the two from drifting apart.
 */
export function validateReleaseServerUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '')
    return { ok: false, reason: '주소가 비어 있습니다.' }
  if (raw !== raw.trim()) return { ok: false, reason: '주소의 앞뒤에 공백이 있습니다.' }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: '주소 형식이 올바르지 않습니다.' }
  }
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: '주소에 인증 정보를 넣을 수 없습니다.' }
  if (url.search !== '' || url.hash !== '')
    return { ok: false, reason: '주소에 쿼리나 해시를 넣을 수 없습니다.' }
  if (url.protocol !== 'https:') return { ok: false, reason: 'https 주소만 사용할 수 있습니다.' }
  if (LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost'))
    return { ok: false, reason: '이 PC를 가리키는 주소는 배포용으로 쓸 수 없습니다.' }
  return { ok: true, baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
}

/** The value the build will see: the shell's and the `.env` files', exactly as electron-vite reads them. */
export function valueTheBuildWillSee(root) {
  return loadEnv('production', root, 'MAIN_VITE_')[NAME]
}

async function jsFiles(folder) {
  const found = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) found.push(...(await jsFiles(path)))
    else if (entry.name.endsWith('.js')) found.push(path)
  }
  return found
}

/** After the build: the address is in the app, and the placeholder the build should have replaced is gone. */
export async function checkBuilt(out, raw) {
  let files
  try {
    files = await jsFiles(join(out, 'main'))
  } catch {
    return { ok: false, reason: `빌드 결과물을 찾을 수 없습니다(${join(out, 'main')}).` }
  }
  let found = false
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    if (text.includes(`import.meta.env.${NAME}`))
      return {
        ok: false,
        reason: '빌드가 서버 주소를 앱에 넣지 못했습니다(자리표시자가 그대로 남아 있습니다).'
      }
    if (text.includes(JSON.stringify(raw).slice(1, -1))) found = true
  }
  return found
    ? { ok: true }
    : { ok: false, reason: '빌드 결과물에 지정한 서버 주소가 들어 있지 않습니다.' }
}

async function main(argv) {
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const here = join(dirname(fileURLToPath(import.meta.url)), '..')
  const root = resolve(option('--root') ?? here)
  const out = resolve(option('--out') ?? join(root, 'out'))
  const raw = valueTheBuildWillSee(root)
  const checked = validateReleaseServerUrl(raw)
  if (!checked.ok) {
    console.error(`서버 주소가 없거나 쓸 수 없어 패키징을 중단합니다: ${checked.reason}`)
    console.error(
      `패키징할 때 ${NAME}에 https 서버 주소를 지정하세요. 예: ${NAME}=https://api.example.com/api/v1 pnpm package`
    )
    return 1
  }
  if (argv.includes('--built')) {
    const built = await checkBuilt(out, raw)
    if (!built.ok) {
      console.error(`패키징을 중단합니다: ${built.reason}`)
      return 1
    }
    console.log(`서버 주소가 앱에 들어갔습니다: ${checked.baseUrl}`)
    return 0
  }
  console.log(`패키징할 서버 주소: ${checked.baseUrl}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2))
