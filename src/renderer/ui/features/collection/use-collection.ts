import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CollectionCommandRequest,
  CollectionSnapshot
} from '../../../../shared/contracts/collection'
import type { Result } from '../../../../shared/contracts/common'
import type { CollectionApi } from '../../../../shared/ipc/collection-api'

/** Keeps the later of two snapshots; Main numbers them, so a late arrival cannot replace a newer one. */
export function newestCollectionSnapshot(
  current: CollectionSnapshot | null,
  incoming: CollectionSnapshot
): CollectionSnapshot {
  return current === null || incoming.revision >= current.revision ? incoming : current
}

const unavailable = 'Main 프로세스와 연결하지 못했어요. 앱을 다시 실행해 주세요.'

/** The collection settings from Main. Opening a screen that shows them (`active`) reads them again. */
export function useCollection(api: CollectionApi | undefined, active: boolean) {
  const [snapshot, setSnapshot] = useState<CollectionSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<CollectionSnapshot | null>(null)

  const apply = useCallback((incoming: CollectionSnapshot) => {
    latest.current = newestCollectionSnapshot(latest.current, incoming)
    setSnapshot(latest.current)
  }, [])

  const settle = useCallback(
    (result: Result<CollectionSnapshot>) => {
      if (result.ok) {
        setError(null)
        apply(result.value)
      } else setError(result.error.message)
    },
    [apply]
  )

  const command = useCallback(
    async (request: CollectionCommandRequest): Promise<void> => {
      if (api) settle(await api.command(request))
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
