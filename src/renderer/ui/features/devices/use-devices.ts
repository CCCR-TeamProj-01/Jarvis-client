import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '../../../../shared/contracts/common'
import type {
  DeviceCommandRequest,
  DeviceManagementSnapshot
} from '../../../../shared/contracts/devices'
import type { DevicesApi } from '../../../../shared/ipc/devices-api'

/** Keeps the later of two snapshots; Main numbers them, so a late arrival cannot replace a newer one. */
export function newestDeviceSnapshot(
  current: DeviceManagementSnapshot | null,
  incoming: DeviceManagementSnapshot
): DeviceManagementSnapshot {
  return current === null || incoming.revision >= current.revision ? incoming : current
}

const unavailable = 'Main 프로세스와 연결하지 못했어요. 앱을 다시 실행해 주세요.'

/**
 * The devices and allowed apps from Main. Opening a screen that shows them (`active`) reads them
 * again, so the list is what the server holds when the user looks at it.
 */
export function useDevices(api: DevicesApi | undefined, active: boolean) {
  const [snapshot, setSnapshot] = useState<DeviceManagementSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<DeviceManagementSnapshot | null>(null)

  const apply = useCallback((incoming: DeviceManagementSnapshot) => {
    latest.current = newestDeviceSnapshot(latest.current, incoming)
    setSnapshot(latest.current)
  }, [])

  const settle = useCallback(
    (result: Result<DeviceManagementSnapshot>) => {
      if (result.ok) {
        setError(null)
        apply(result.value)
      } else setError(result.error.message)
    },
    [apply]
  )

  const command = useCallback(
    async (request: DeviceCommandRequest): Promise<void> => {
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
