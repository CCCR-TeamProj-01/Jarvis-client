import {
  LOGIN_ID_RULE,
  PASSWORD_RULE,
  characterCount,
  isValidLoginId
} from '../../../../shared/contracts/auth'
import { isLoginIdConfirmed } from './login-id-check'
import type { LoginIdCheckState } from './login-id-check'

export interface FieldErrors {
  loginId?: string
  password?: string
  confirmation?: string
}

const isBlank = (value: string): boolean => value.trim().length === 0

/** Why an ID cannot be used, or undefined. The same rule as the shared contract. */
export function validateLoginId(loginId: string): string | undefined {
  if (isBlank(loginId)) return '아이디를 입력해 주세요.'
  if (!isValidLoginId(loginId))
    return `아이디는 공백 없이 영문, 숫자, _로 ${LOGIN_ID_RULE.min}~${LOGIN_ID_RULE.max}자여야 해요.`
  return undefined
}

const TOO_LONG = `비밀번호는 ${PASSWORD_RULE.max}자 이하여야 해요.`

/** Signing in only needs a password the server could hold: present and not over the maximum. */
export function validateSignIn(input: { loginId: string; password: string }): FieldErrors {
  const errors: FieldErrors = {}
  const loginId = validateLoginId(input.loginId)
  if (loginId) errors.loginId = loginId
  if (input.password.length === 0) errors.password = '비밀번호를 입력해 주세요.'
  else if (characterCount(input.password) > PASSWORD_RULE.max) errors.password = TOO_LONG
  return errors
}

/**
 * The confirmation field exists only in the form; it is compared here and never sent to Main.
 * A new password must reach the minimum length; its characters are not restricted.
 */
export function validateSignUp(input: {
  loginId: string
  password: string
  confirmation: string
  check: LoginIdCheckState
}): FieldErrors {
  const errors = validateSignIn(input)
  if (!errors.password && characterCount(input.password) < PASSWORD_RULE.signUpMin)
    errors.password = `비밀번호는 ${PASSWORD_RULE.signUpMin}자 이상이어야 해요.`
  if (!errors.loginId && !isLoginIdConfirmed(input.check, input.loginId))
    errors.loginId =
      input.check.status === 'taken' && input.check.loginId === input.loginId
        ? '이미 사용 중인 아이디예요.'
        : '아이디 중복 확인이 필요해요.'
  if (!errors.password && input.confirmation.length === 0)
    errors.confirmation = '비밀번호를 한 번 더 입력해 주세요.'
  else if (!errors.password && input.confirmation !== input.password)
    errors.confirmation = '비밀번호가 서로 달라요.'
  return errors
}

export const hasErrors = (errors: FieldErrors): boolean => Object.keys(errors).length > 0
