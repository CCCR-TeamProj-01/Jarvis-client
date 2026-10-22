import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalendarNavigation, CalendarSnapshot } from '../../../../shared/contracts/calendar'
import type { Result } from '../../../../shared/contracts/common'
import type { CalendarApi } from '../../../../shared/ipc/calendar-api'

/** Keeps the later of two snapshots; Main numbers them, so a late arrival cannot replace a newer one. */
export function newestCalendarSnapshot(
  current: CalendarSnapshot | null,
  incoming: CalendarSnapshot
): CalendarSnapshot {
  return current === null || incoming.revision >= current.revision ? incoming : current
}

const unavailable = 'Main 프로세스와 연결하지 못했어요. 앱을 다시 실행해 주세요.'

/**
 * The calendar tab's state from Main. Opening the tab (`active`) reads the calendar again, so what
 * it shows is never older than the last time the user looked.
 */
export function useCalendar(api: CalendarApi | undefined, active: boolean) {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<CalendarSnapshot | null>(null)

  const apply = useCallback((incoming: CalendarSnapshot) => {
    latest.current = newestCalendarSnapshot(latest.current, incoming)
    setSnapshot(latest.current)
  }, [])

  const settle = useCallback(
    (result: Result<CalendarSnapshot>) => {
      if (result.ok) {
        setError(null)
        apply(result.value)
      } else setError(result.error.message)
    },
    [apply]
  )

  const navigate = useCallback(
    async (navigation: CalendarNavigation): Promise<void> => {
      if (api) settle(await api.navigate({ navigation }))
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
    void api.navigate({ navigation: 'refresh' }).then((result) => {
      if (live) settle(result)
    })
    return () => {
      live = false
    }
  }, [api, active, settle])

  return { snapshot, error: api ? error : unavailable, navigate }
}
