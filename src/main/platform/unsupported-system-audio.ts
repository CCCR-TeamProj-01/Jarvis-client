import type { Result } from '../../shared/contracts/common'
import type { SystemAudioPort } from './ports'

const unsupported = async (): Promise<Result<never>> => ({
  ok: false,
  error: { code: 'unsupported', message: '이 운영체제의 볼륨 제어는 아직 지원하지 않습니다.' }
})

/** For platforms without an audio adapter (neither macOS nor Windows). */
export const unsupportedSystemAudio: SystemAudioPort = {
  setVolume: unsupported,
  adjustVolume: unsupported,
  setMuted: unsupported
}
