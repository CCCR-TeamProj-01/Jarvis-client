import type { ClientError, Result } from '../../shared/contracts/common'

/** What the server is told about this machine when a login registers it. */
export interface DeviceInfo {
  deviceKey: string
  deviceName: string
  platform: 'windows' | 'macos'
  clientVersion: string
}

interface DeviceInfoInput {
  /** The installation key; null until the local state has been initialised. */
  deviceKey: string | null
  hostname: string
  platform: NodeJS.Platform
  appVersion: string
}

const NAME_LIMIT = 100
const VERSION_LIMIT = 32

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

/** The name shown in the account's device list: the computer's name, without control characters. */
function cleanName(hostname: string, fallback: string): string {
  const name = Array.from(hostname, (character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f ? ' ' : character
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_LIMIT)
    .trim()
  return name === '' ? fallback : name
}

export function deviceInfoFrom(input: DeviceInfoInput): Result<DeviceInfo> {
  if (input.deviceKey === null)
    return failure('device_unavailable', '이 기기의 설치 정보를 아직 준비하지 못했습니다.')
  const platform =
    input.platform === 'darwin' ? 'macos' : input.platform === 'win32' ? 'windows' : null
  if (platform === null)
    return failure('unsupported', '이 운영체제에서는 서버 로그인을 지원하지 않습니다.')
  return {
    ok: true,
    value: {
      deviceKey: input.deviceKey,
      deviceName: cleanName(input.hostname, platform === 'macos' ? 'Mac' : 'Windows PC'),
      platform,
      clientVersion: input.appVersion.slice(0, VERSION_LIMIT) || '0.0.0'
    }
  }
}
