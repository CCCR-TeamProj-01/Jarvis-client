/** Where the server is, or why it is not usable. Anything but `ready` means "server unreachable". */
export type ServerConfigResult =
  | { status: 'unconfigured' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; baseUrl: string }

interface ServerConfigInput {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
}

/** Plain http is only for a server on this machine; everything else must use https. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

const invalid = (reason: string): ServerConfigResult => ({ status: 'invalid', reason })

/**
 * Development only: an unpackaged app with JARVIS_SERVER_URL set. A packaged build has no way to
 * be pointed at a server yet (the production address is injected once it is known), so it stays
 * unconfigured and an environment variable can never redirect it.
 */
export function resolveServerConfig({ isPackaged, env }: ServerConfigInput): ServerConfigResult {
  if (isPackaged) return { status: 'unconfigured' }
  const raw = env.JARVIS_SERVER_URL
  if (raw === undefined || raw.trim() === '') return { status: 'unconfigured' }
  return parseServerBaseUrl(raw)
}

export function parseServerBaseUrl(raw: string): ServerConfigResult {
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
  if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))
    return invalid('https 주소만 사용할 수 있습니다(같은 PC의 개발 서버만 http 허용).')
  return { status: 'ready', baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
}
