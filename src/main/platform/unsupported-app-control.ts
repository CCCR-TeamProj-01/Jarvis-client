import type { Result } from '../../shared/contracts/common'
import { HttpUrlSchema } from '../../shared/contracts/tools'
import type { UrlObservation } from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'
import type { AppControlPort } from './ports'

const unsupported = async (): Promise<Result<never>> => ({
  ok: false,
  error: { code: 'unsupported', message: '이 운영체제의 앱 제어는 아직 지원하지 않습니다.' }
})

/**
 * For platforms without an app adapter yet (Windows is follow-up work). Everything that needs the
 * OS reports `unsupported`; only handing a URL to the default browser works everywhere.
 */
export function createUnsupportedAppControl(
  openUrl: (url: string) => Promise<void>
): AppControlPort {
  return {
    list: unsupported,
    launch: unsupported,
    activate: unsupported,
    restore: unsupported,
    switchRecentTask: unsupported,
    getForegroundWindow: async () => ({ ok: true, value: null }),
    async openUrl(url: string, options?: LocalExecutionOptions): Promise<Result<UrlObservation>> {
      const parsed = HttpUrlSchema.safeParse(url)
      if (!parsed.success)
        return {
          ok: false,
          error: { code: 'invalid_input', message: 'http 또는 https 주소만 열 수 있습니다.' }
        }
      if (options?.signal?.aborted)
        return { ok: false, error: { code: 'cancelled', message: '요청이 취소되었습니다.' } }
      try {
        await openUrl(parsed.data)
      } catch {
        return {
          ok: false,
          error: { code: 'unavailable', message: '기본 브라우저로 주소를 전달하지 못했습니다.' }
        }
      }
      return { ok: true, value: { kind: 'url', url: parsed.data, status: 'dispatched' } }
    }
  }
}
