import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '../../../../shared/contracts/common'
import type {
  DiagnosticsFrame,
  DiagnosticsSnapshot
} from '../../../../shared/contracts/gesture-diagnostics'
import type { GestureDiagnosticsApi } from '../../../../shared/ipc/gesture-diagnostics-api'

/** Keeps the later of two snapshots; Main numbers them, so a late arrival cannot replace a newer one. */
export function newestDiagnosticsSnapshot(
  current: DiagnosticsSnapshot | null,
  incoming: DiagnosticsSnapshot
): DiagnosticsSnapshot {
  return current === null || incoming.revision >= current.revision ? incoming : current
}

const unavailable = 'Main 프로세스와 연결하지 못했어요. 앱을 다시 실행해 주세요.'

/**
 * The recognition view from Main. It starts only when asked, and it is turned off again when the
 * screen that shows it is left (`active` goes false) or closed, so the camera is not kept for a
 * view nobody is looking at.
 */
export function useGestureDiagnostics(api: GestureDiagnosticsApi | undefined, active: boolean) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [frame, setFrame] = useState<DiagnosticsFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<DiagnosticsSnapshot | null>(null)

  const apply = useCallback((incoming: DiagnosticsSnapshot) => {
    latest.current = newestDiagnosticsSnapshot(latest.current, incoming)
    setSnapshot(latest.current)
    // A view that is not on shows no picture; the last one must not linger.
    if (latest.current.state !== 'on') setFrame(null)
  }, [])

  const settle = useCallback(
    (result: Result<DiagnosticsSnapshot>) => {
      if (result.ok) {
        setError(null)
        apply(result.value)
      } else setError(result.error.message)
    },
    [apply]
  )

  const command = useCallback(
    async (action: 'start' | 'stop'): Promise<void> => {
      if (api) settle(await api.command({ action }))
    },
    [api, settle]
  )

  useEffect(() => {
    if (!api) return
    let live = true
    const unsubscribe = api.subscribe((event) => {
      if (!live) return
      if (event.type === 'gesture_diagnostics.state_changed') apply(event.snapshot)
      else setFrame(event.frame)
    })
    void api.getSnapshot().then((result) => {
      if (live && result.ok) apply(result.value)
    })
    return () => {
      live = false
      unsubscribe()
      // The window is going away: the camera goes back with it.
      if (latest.current && latest.current.state !== 'off') void api.command({ action: 'stop' })
    }
  }, [api, apply])

  useEffect(() => {
    if (!api || active) return
    if (latest.current && latest.current.state !== 'off') void api.command({ action: 'stop' })
  }, [api, active])

  return { snapshot, frame, error: api ? error : unavailable, command }
}
