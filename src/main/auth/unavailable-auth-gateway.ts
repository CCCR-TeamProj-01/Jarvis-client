import type { Result } from '../../shared/contracts/common'
import type { AuthGatewayPort } from './ports'

const unavailable = (): Result<never> => ({
  ok: false,
  error: {
    code: 'unavailable',
    message: '로그인 서버에 아직 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'
  }
})

/**
 * Default until the real server adapter exists. Every call fails, so a build without an explicit
 * development opt-in can never authenticate, and restore reports a transient (not invalid) error
 * so a stored credential is kept.
 */
export const unavailableAuthGateway: AuthGatewayPort = {
  checkLoginId: async () => unavailable(),
  signUp: async () => unavailable(),
  signIn: async () => unavailable(),
  restore: async () => unavailable(),
  signOut: async () => unavailable()
}
