import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '../../../../shared/contracts/common'
import type {
  GoogleAction,
  GoogleConnectionSnapshot
} from '../../../../shared/contracts/google-connection'
import type { GoogleConnectionApi } from '../../../../shared/ipc/google-api'

/** Keeps the later of two snapshots; Main numbers them, so a late arrival cannot replace a newer one. */
export function newestGoogleSnapshot(
  current: GoogleConnectionSnapshot | null,
  incoming: GoogleConnectionSnapshot
): GoogleConnectionSnapshot {
  return current === null || incoming.revision >= current.revision ? incoming : current
}

const unavailable = 'Main 프로세스와 연결하지 못했어요. 앱을 다시 실행해 주세요.'

/**
 * The Google Calendar connection from Main. Opening a screen that shows it (`active`) reads it
 * again, which is also when Main decides whether the last import is old enough to start another.
 */
export function useGoogleConnection(api: GoogleConnectionApi | undefined, active: boolean) {
  const [snapshot, setSnapshot] = useState<GoogleConnectionSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<GoogleConnectionSnapshot | null>(null)

  const apply = useCallback((incoming: GoogleConnectionSnapshot) => {
    latest.current = newestGoogleSnapshot(latest.current, incoming)
    setSnapshot(latest.current)
  }, [])

  const settle = useCallback(
    (result: Result<GoogleConnectionSnapshot>) => {
      if (result.ok) {
        setError(null)
        apply(result.value)
      } else setError(result.error.message)
    },
    [apply]
  )

  const command = useCallback(
    async (action: GoogleAction): Promise<void> => {
      if (api) settle(await api.command({ action }))
    },
    [api, settle]
  )

  useEffect(() => {
    if (!api) return
    let live = true
    const unsubscribe = api.subscribe((event) => {
      if (live) apply(event.snapshot)
    })
    void api.getSnapshot().then((result) => {
      if (live && result.ok) apply(result.value)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [api, apply])

  useEffect(() => {
    if (!api || !active) return
    let live = true
    void api.command({ action: 'refresh' }).then((result) => {
      if (live) settle(result)
    })
    return () => {
      live = false
    }
  }, [api, active, settle])

  return { snapshot, error: api ? error : unavailable, command }
}
