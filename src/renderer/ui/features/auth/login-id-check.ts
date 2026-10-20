/**
 * Duplicate-check state for the sign-up form. A result counts only while its token is still the
 * active one and the ID it answered is still the ID in the field, so editing the ID (including
 * A -> B -> A) or starting a newer check can never revive an older response.
 */
export type LoginIdCheckStatus = 'unchecked' | 'checking' | 'available' | 'taken' | 'error'

export interface LoginIdCheckState {
  loginId: string
  status: LoginIdCheckStatus
  /** Token of the request whose answer is still wanted; null when nothing is awaited. */
  activeToken: number | null
  message: string | null
}

export type LoginIdCheckAction =
  | { type: 'edit'; loginId: string }
  | { type: 'start'; token: number }
  | { type: 'result'; token: number; loginId: string; available: boolean }
  | { type: 'failed'; token: number; loginId: string; message: string }
  /** The server's final uniqueness decision at sign-up overrides any earlier availability. */
  | { type: 'taken'; loginId: string }
  | { type: 'reset' }

export const initialLoginIdCheck: LoginIdCheckState = {
  loginId: '',
  status: 'unchecked',
  activeToken: null,
  message: null
}

export function loginIdCheckReducer(
  state: LoginIdCheckState,
  action: LoginIdCheckAction
): LoginIdCheckState {
  switch (action.type) {
    case 'edit':
      return action.loginId === state.loginId
        ? state
        : { loginId: action.loginId, status: 'unchecked', activeToken: null, message: null }
    case 'start':
      return state.loginId.trim().length === 0
        ? state
        : { ...state, status: 'checking', activeToken: action.token, message: null }
    case 'result':
      if (!isAwaited(state, action)) return state
      return {
        ...state,
        status: action.available ? 'available' : 'taken',
        activeToken: null,
        message: null
      }
    case 'failed':
      if (!isAwaited(state, action)) return state
      return { ...state, status: 'error', activeToken: null, message: action.message }
    case 'taken':
      return action.loginId === state.loginId
        ? { ...state, status: 'taken', activeToken: null, message: null }
        : state
    case 'reset':
      return initialLoginIdCheck
  }
}

function isAwaited(state: LoginIdCheckState, action: { token: number; loginId: string }): boolean {
  return (
    state.status === 'checking' &&
    state.activeToken === action.token &&
    state.loginId === action.loginId
  )
}

/** "Available" only holds for the exact ID that was checked. */
export function isLoginIdConfirmed(state: LoginIdCheckState, loginId: string): boolean {
  return state.status === 'available' && state.loginId === loginId
}
