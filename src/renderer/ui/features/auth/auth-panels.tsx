import { useReducer, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, CircleAlert, CircleCheck, Info, LoaderCircle } from 'lucide-react'
import type { CheckLoginIdResult, SignUpResult } from '../../../../shared/contracts/auth'
import type { Result } from '../../../../shared/contracts/common'
import { hasErrors, validateSignIn, validateSignUp } from './auth-form'
import { initialLoginIdCheck, loginIdCheckReducer } from './login-id-check'
import type { AuthBusy } from './use-auth'

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p className="field-error" id={id} role="alert">
      <CircleAlert aria-hidden="true" />
      {message}
    </p>
  ) : null
}

function Messages({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error && (
        <p className="notice notice-error" role="alert">
          <CircleAlert aria-hidden="true" />
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice-warning" role="status">
          <Info aria-hidden="true" />
          {notice}
        </p>
      )}
    </>
  )
}

interface SignInFormProps {
  busy: AuthBusy
  error: string | null
  notice: string | null
  initialLoginId: string
  onSubmit(loginId: string, password: string): Promise<boolean>
}

export function SignInForm({ busy, error, notice, initialLoginId, onSubmit }: SignInFormProps) {
  const [loginId, setLoginId] = useState(initialLoginId)
  const [password, setPassword] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const errors = showErrors ? validateSignIn({ loginId, password }) : {}
  const pending = busy === 'signIn'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy !== null) return
    if (hasErrors(validateSignIn({ loginId, password }))) {
      setShowErrors(true)
      return
    }
    if (await onSubmit(loginId, password)) setPassword('')
  }

  return (
    <form className="account-form" aria-label="로그인 양식" noValidate onSubmit={submit}>
      <label htmlFor="login-id">아이디</label>
      <input
        id="login-id"
        name="loginId"
        autoComplete="username"
        placeholder="아이디를 입력하세요"
        value={loginId}
        disabled={busy !== null}
        aria-invalid={errors.loginId ? true : undefined}
        aria-describedby={errors.loginId ? 'login-id-error' : undefined}
        onChange={(event) => setLoginId(event.target.value)}
      />
      <FieldError id="login-id-error" message={errors.loginId} />
      <label htmlFor="password">비밀번호</label>
      <input
        id="password"
        type="password"
        name="password"
        autoComplete="current-password"
        placeholder="비밀번호를 입력하세요"
        value={password}
        disabled={busy !== null}
        aria-invalid={errors.password ? true : undefined}
        aria-describedby={errors.password ? 'password-error' : undefined}
        onChange={(event) => setPassword(event.target.value)}
      />
      <FieldError id="password-error" message={errors.password} />
      <Messages error={error} notice={notice} />
      <button className="button button-primary" type="submit" disabled={busy !== null}>
        {pending ? '로그인 중…' : '로그인'}
        {pending ? (
          <LoaderCircle className="spin" aria-hidden="true" />
        ) : (
          <ArrowRight aria-hidden="true" />
        )}
      </button>
    </form>
  )
}

interface SignUpFormProps {
  busy: AuthBusy
  error: string | null
  checkLoginId(loginId: string): Promise<Result<CheckLoginIdResult>>
  onSubmit(loginId: string, password: string): Promise<Result<SignUpResult> | null>
  onSignedUp(loginId: string): void
}

export function SignUpForm({ busy, error, checkLoginId, onSubmit, onSignedUp }: SignUpFormProps) {
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [check, dispatch] = useReducer(loginIdCheckReducer, initialLoginIdCheck)
  const tokenRef = useRef(0)
  const errors = showErrors ? validateSignUp({ loginId, password, confirmation, check }) : {}
  const pending = busy === 'signUp'

  async function runCheck() {
    if (loginId.trim().length === 0) {
      setShowErrors(true)
      return
    }
    const token = ++tokenRef.current
    const requested = loginId
    dispatch({ type: 'start', token })
    const result = await checkLoginId(requested)
    if (result.ok)
      dispatch({ type: 'result', token, loginId: requested, available: result.value.available })
    else dispatch({ type: 'failed', token, loginId: requested, message: result.error.message })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy !== null) return
    if (hasErrors(validateSignUp({ loginId, password, confirmation, check }))) {
      setShowErrors(true)
      return
    }
    const result = await onSubmit(loginId, password)
    if (!result) return
    if (result.ok) {
      setPassword('')
      setConfirmation('')
      onSignedUp(result.value.loginId)
    } else if (result.error.code === 'login_id_taken') {
      dispatch({ type: 'taken', loginId })
      setShowErrors(true)
    }
  }

  return (
    <form className="account-form" aria-label="회원가입 양식" noValidate onSubmit={submit}>
      <label htmlFor="login-id">아이디</label>
      <div className="input-row">
        <input
          id="login-id"
          name="loginId"
          autoComplete="username"
          placeholder="아이디를 입력하세요"
          value={loginId}
          disabled={busy !== null}
          aria-invalid={errors.loginId ? true : undefined}
          aria-describedby="login-id-status"
          onChange={(event) => {
            setLoginId(event.target.value)
            dispatch({ type: 'edit', loginId: event.target.value })
          }}
        />
        <button
          type="button"
          className="button button-secondary"
          disabled={busy !== null || check.status === 'checking' || loginId.trim().length === 0}
          onClick={() => void runCheck()}
        >
          {check.status === 'checking' ? '확인 중…' : '중복 확인'}
        </button>
      </div>
      <div id="login-id-status" aria-live="polite">
        {check.status === 'available' && check.loginId === loginId && (
          <p className="field-hint field-hint-ok">
            <CircleCheck aria-hidden="true" />
            사용할 수 있는 아이디예요.
          </p>
        )}
        {check.status === 'taken' && check.loginId === loginId && !errors.loginId && (
          <p className="field-error">
            <CircleAlert aria-hidden="true" />
            이미 사용 중인 아이디예요.
          </p>
        )}
        {check.status === 'error' && check.loginId === loginId && (
          <p className="field-error">
            <CircleAlert aria-hidden="true" />
            {check.message ?? '중복 확인에 실패했어요. 다시 시도해 주세요.'}
          </p>
        )}
        <FieldError id="login-id-error" message={errors.loginId} />
      </div>
      <label htmlFor="password">비밀번호</label>
      <input
        id="password"
        type="password"
        name="password"
        autoComplete="new-password"
        placeholder="비밀번호를 입력하세요"
        value={password}
        disabled={busy !== null}
        aria-invalid={errors.password ? true : undefined}
        aria-describedby={errors.password ? 'password-error' : undefined}
        onChange={(event) => setPassword(event.target.value)}
      />
      <FieldError id="password-error" message={errors.password} />
      <label htmlFor="password-confirm">비밀번호 재입력</label>
      <input
        id="password-confirm"
        type="password"
        name="passwordConfirmation"
        autoComplete="new-password"
        placeholder="비밀번호를 다시 입력하세요"
        value={confirmation}
        disabled={busy !== null}
        aria-invalid={errors.confirmation ? true : undefined}
        aria-describedby={errors.confirmation ? 'password-confirm-error' : undefined}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <FieldError id="password-confirm-error" message={errors.confirmation} />
      <Messages error={error} notice={null} />
      <button className="button button-primary" type="submit" disabled={busy !== null}>
        {pending ? '가입 중…' : '회원가입'}
        {pending ? (
          <LoaderCircle className="spin" aria-hidden="true" />
        ) : (
          <ArrowRight aria-hidden="true" />
        )}
      </button>
    </form>
  )
}

/** Shown while the stored credential is verified; protected features stay blocked. */
export function CheckingPanel({
  failed,
  busy,
  message,
  onRetry
}: {
  failed: boolean
  busy: AuthBusy
  message: string | null
  onRetry(): void
}) {
  return failed ? (
    <div className="notice notice-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div>
        <p>{message ?? '로그인 정보를 확인하지 못했어요.'}</p>
        <button
          className="button button-ghost"
          type="button"
          disabled={busy !== null}
          onClick={onRetry}
        >
          다시 시도
        </button>
      </div>
    </div>
  ) : (
    <p className="notice" role="status">
      <LoaderCircle className="spin" aria-hidden="true" />
      로그인 정보를 확인하고 있어요.
    </p>
  )
}
