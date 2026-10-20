import { useCallback, useEffect, useState } from 'react'
import type { ClientSnapshot, UiCommand } from '../../shared/contracts/interaction'
import type { InteractionUiApi } from '../../shared/ipc/ui-api'

export function newestSnapshot(
  current: ClientSnapshot | null,
  incoming: ClientSnapshot
): ClientSnapshot {
  return current === null || incoming.revision >= current.revision ? incoming : current
}

export function useClientSnapshot(api: InteractionUiApi | undefined) {
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    if (!api) {
      setError('앱과 연결하지 못했습니다. 다시 실행해 주세요.')
      return
    }
    const result = await api.getSnapshot()
    if (result.ok) {
      setSnapshot((current) => newestSnapshot(current, result.value))
      setError(null)
    } else setError(result.error.message)
  }, [api])

  useEffect(() => {
    if (!api) return
    let active = true
    const unsubscribe = api.subscribe((event) => {
      if (!active) return
      if (event.type === 'state.changed')
        setSnapshot((current) => newestSnapshot(current, event.snapshot))
      else if (event.type === 'client.error') setError(event.error.message)
    })
    void api.getSnapshot().then((result) => {
      if (!active) return
      if (result.ok) setSnapshot((current) => newestSnapshot(current, result.value))
      else setError(result.error.message)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  const dispatch = useCallback(
    async (command: UiCommand) => {
      if (!api) return
      setError(null)
      const result = await api.dispatch(command)
      if (!result.ok) setError(result.error.message)
    },
    [api]
  )

  return {
    snapshot,
    error: !api ? '앱과 연결하지 못했습니다. 다시 실행해 주세요.' : error,
    refresh,
    dispatch
  }
}
