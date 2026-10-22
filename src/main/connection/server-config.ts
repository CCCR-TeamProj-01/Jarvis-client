/** Where the server is, or why it is not usable. Anything but `ready` means "server unreachable". */
export type ServerConfigResult =
  | { status: 'unconfigured' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; baseUrl: string }

interface ServerConfigInput {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The address put into the app when it was built (`MAIN_VITE_JARVIS_SERVER_URL`). */
  bundledUrl?: string | undefined
}

/** Plain http is only for a server on this machine; everything else must use https. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

const invalid = (reason: string): ServerConfigResult => ({ status: 'invalid', reason })

/**
 * Where the server is.
 *
 * - An installed (packaged) app uses only the address that was put into it when it was built, and
 *   only an `https` one. No environment variable, file or setting can point it somewhere else, so a
 *   distributed app cannot be redirected to a stand-in server. Without a built-in address it stays
 *   unconfigured, which callers report as "server unreachable".
 * - An unpackaged (development) app uses `JARVIS_SERVER_URL`, and ignores the built-in address.
 */
export function resolveServerConfig({
  isPackaged,
  env,
  bundledUrl
}: ServerConfigInput): ServerConfigResult {
  if (isPackaged) {
    if (bundledUrl === undefined || bundledUrl.trim() === '') return { status: 'unconfigured' }
    return parseServerBaseUrl(bundledUrl, { httpsOnly: true })
  }
  const raw = env.JARVIS_SERVER_URL
  if (raw === undefined || raw.trim() === '') return { status: 'unconfigured' }
  return parseServerBaseUrl(raw)
}

/** `httpsOnly` is for an installed app, which never talks to a server on the same machine over http. */
export function parseServerBaseUrl(
  raw: string,
  { httpsOnly = false }: { httpsOnly?: boolean } = {}
): ServerConfigResult {
  if (raw !== raw.trim()) return invalid('서버 주소의 앞뒤에 공백이 있습니다.')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return invalid('서버 주소 형식이 올바르지 않습니다.')
  }
  if (url.username !== '' || url.password !== '')
    return invalid('서버 주소에 인증 정보를 넣을 수 없습니다.')
  if (url.search !== '' || url.hash !== '')
    return invalid('서버 주소에 쿼리나 해시를 넣을 수 없습니다.')
  const secure = url.protocol === 'https:'
  if (httpsOnly) {
    if (!secure) return invalid('https 주소만 사용할 수 있습니다.')
  } else if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))
    return invalid('https 주소만 사용할 수 있습니다(같은 PC의 개발 서버만 http 허용).')
  return { status: 'ready', baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
}
