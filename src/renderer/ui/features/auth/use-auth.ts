import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuthEvent,
  AuthSnapshot,
  CheckLoginIdResult,
  SignUpResult
} from '../../../../shared/contracts/auth'
import type { Result } from '../../../../shared/contracts/common'
import type { AuthApi } from '../../../../shared/ipc/auth-api'

export type AuthBusy = 'signIn' | 'signUp' | 'restore' | 'signOut' | null

/** Ignore snapshots from before the one already shown (same app run, lower revision). */
export function newestAuthSnapshot(
  current: AuthSnapshot | null,
  incoming: AuthSnapshot
): AuthSnapshot {
  if (current === null) return incoming
  if (current.generation.sessionId !== incoming.generation.sessionId) return incoming
  return incoming.generation.revision >= current.generation.revision ? incoming : current
}

const unavailable = 'Main 프로세스와 연결하지 못했어요. 앱을 다시 실행해 주세요.'

export function useAuth(api: AuthApi | undefined) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot | null>(null)
  const [busy, setBusy] = useState<AuthBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Restoration failed transiently; the stored credential was kept and a retry is possible. */
  const [restoreFailed, setRestoreFailed] = useState(false)
  const snapshotRef = useRef<AuthSnapshot | null>(null)
  const busyRef = useRef<AuthBusy>(null)

  const apply = useCallback((incoming: AuthSnapshot) => {
    const next = newestAuthSnapshot(snapshotRef.current, incoming)
    snapshotRef.current = next
    setSnapshot(next)
    if (next.phase !== 'checking') setRestoreFailed(false)
  }, [])

  useEffect(() => {
    if (!api) return
    let active = true
    const onEvent = (event: AuthEvent) => {
      if (!active) return
      if (event.type === 'auth.state_changed') apply(event.snapshot)
      else if (event.requestId === null) {
        if (snapshotRef.current?.phase === 'checking') setRestoreFailed(true)
        setNotice(event.error.message)
      }
    }
    const unsubscribe = api.subscribe(onEvent)
    void api.getSnapshot().then((result) => {
      if (!active) return
      if (result.ok) apply(result.value)
      else setError(result.error.message)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api, apply])

  /** One exclusive operation at a time (the form also disables itself while busy). */
  const run = useCallback(
    async <T>(kind: Exclude<AuthBusy, null>, call: () => Promise<Result<T>>) => {
      if (busyRef.current !== null) return null
      busyRef.current = kind
      setBusy(kind)
      setError(null)
      setNotice(null)
      try {
        return await call()
      } finally {
        busyRef.current = null
        setBusy(null)
      }
    },
    []
  )

  const context = useCallback(() => {
    const current = snapshotRef.current
    return current ? { requestId: crypto.randomUUID(), generation: current.generation } : null
  }, [])

  const signIn = useCallback(
    async (loginId: string, password: string): Promise<boolean> => {
      const request = context()
      if (!api || !request) return false
      const result = await run('signIn', () =>
        api.signIn({ ...request, input: { loginId, password } })
      )
      if (!result) return false
      if (!result.ok) {
        setError(result.error.message)
        return false
      }
      apply(result.value.snapshot)
      if (result.value.persistence.status === 'unavailable')
        setNotice(
          `${result.value.persistence.error.message} 이번 실행에서만 로그인 상태가 유지돼요.`
        )
      return true
    },
    [api, apply, run, context]
  )

  const signUp = useCallback(
    async (loginId: string, password: string): Promise<Result<SignUpResult> | null> => {
      const request = context()
      if (!api || !request) return null
      const result = await run('signUp', () =>
        api.signUp({ ...request, input: { loginId, password } })
      )
      if (result && !result.ok) setError(result.error.message)
      return result
    },
    [api, run, context]
  )

  /** Duplicate checks may overlap with typing, so they bypass the exclusive-operation lock. */
  const checkLoginId = useCallback(
    async (loginId: string): Promise<Result<CheckLoginIdResult>> => {
      const request = context()
      if (!api || !request)
        return { ok: false, error: { code: 'unavailable', message: unavailable } }
      return api.checkLoginId({ ...request, input: { loginId } })
    },
    [api, context]
  )

  const restore = useCallback(async (): Promise<void> => {
    const request = context()
    if (!api || !request) return
    setRestoreFailed(false)
    const result = await run('restore', () => api.restore(request))
    if (!result) return
    if (result.ok) apply(result.value.snapshot)
    else if (snapshotRef.current?.phase === 'checking') setRestoreFailed(true)
  }, [api, apply, run, context])

  const signOut = useCallback(async (): Promise<void> => {
    const request = context()
    if (!api || !request) return
    const result = await run('signOut', () => api.signOut(request))
    if (result && !result.ok) setError(result.error.message)
  }, [api, run, context])

  const clearMessages = useCallback(() => {
    setError(null)
    setNotice(null)
  }, [])

  return {
    snapshot,
    busy,
    error: api ? error : unavailable,
    notice,
    restoreFailed,
    signIn,
    signUp,
    checkLoginId,
    restore,
    signOut,
    clearMessages
  }
}
