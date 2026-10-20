import type { AuthPort } from '../auth/auth-manager'
import type { SensorGate } from './hardware'

/**
 * Sensors start only for a signed-in user whose recognition is not paused. Both are read from
 * Main's own state at the moment of the request, never from anything the UI reports.
 */
export function createSensorGate(
  auth: Pick<AuthPort, 'getSnapshot'>,
  isRecognitionPaused: () => boolean
): SensorGate {
  return {
    check() {
      if (auth.getSnapshot().phase !== 'signed_in')
        return {
          ok: false,
          error: { code: 'authentication_required', message: '로그인이 필요합니다.' }
        }
      if (isRecognitionPaused())
        return {
          ok: false,
          error: { code: 'unavailable', message: '인식이 일시 중지되어 있습니다.' }
        }
      return { ok: true, value: undefined }
    }
  }
}
