import type { Result } from '../../../shared/contracts/common'
import type { AssistantPort } from '../../conversation/ports'
import type { RemoteSpeechPort } from './ports'

const unavailable = async (): Promise<Result<never>> => ({
  ok: false,
  error: {
    code: 'unavailable',
    message: '음성 서버에 아직 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'
  }
})

/** Default until the real server adapter exists: nothing is sent anywhere. */
export const unavailableRemoteSpeech: RemoteSpeechPort = { transcribe: unavailable }

export const unavailableAssistant: AssistantPort = { respond: unavailable }
