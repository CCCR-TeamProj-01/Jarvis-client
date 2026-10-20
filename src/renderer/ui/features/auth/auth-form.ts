import { isLoginIdConfirmed } from './login-id-check'
import type { LoginIdCheckState } from './login-id-check'

export interface FieldErrors {
  loginId?: string
  password?: string
  confirmation?: string
}

const isBlank = (value: string): boolean => value.trim().length === 0

/** Same transport rule as the shared contract: a blank ID or an empty password is not submitted. */
export function validateSignIn(input: { loginId: string; password: string }): FieldErrors {
  const errors: FieldErrors = {}
  if (isBlank(input.loginId)) errors.loginId = '아이디를 입력해 주세요.'
  if (input.password.length === 0) errors.password = '비밀번호를 입력해 주세요.'
  return errors
}

/**
 * The confirmation field exists only in the form; it is compared here and never sent to Main.
 * Length and character rules are applied once they are agreed with the server.
 */
export function validateSignUp(input: {
  loginId: string
  password: string
  confirmation: string
  check: LoginIdCheckState
}): FieldErrors {
  const errors = validateSignIn(input)
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
