import type { ClientError, Result } from '../../shared/contracts/common'
import { HttpUrlSchema } from '../../shared/contracts/tools'
import type { AppObservation, UrlObservation } from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'

/** Pieces every OS app adapter needs the same way; the OS-specific parts stay in each adapter. */

export const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

export function observed(appId: string, status: AppObservation['status']): Result<AppObservation> {
  return { ok: true, value: { kind: 'app', appId, status } }
}

export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export interface PollClock {
  now(): number
  /** Resolves after `ms`, or early when aborted. Injected so confirmation polling can be tested. */
  delay(ms: number, signal?: AbortSignal): Promise<void>
  pollMs?: number
}

/** Poll until `check` holds, the window closes or the caller cancels. Never throws. */
export async function pollUntil(
  check: () => Promise<boolean>,
  withinMs: number,
  clock: PollClock,
  options?: LocalExecutionOptions
): Promise<boolean> {
  const pollMs = clock.pollMs ?? 250
  const end = clock.now() + withinMs
  for (;;) {
    if (options?.signal?.aborted) return false
    if (await check()) return true
    if (clock.now() >= end) return false
    await clock.delay(pollMs, options?.signal)
  }
}

/** Hands a validated http(s) URL to the default browser. Reports the handoff, not page loading. */
export async function handOffUrl(
  url: string,
  openUrl: (url: string) => Promise<void>,
  options?: LocalExecutionOptions
): Promise<Result<UrlObservation>> {
  const parsed = HttpUrlSchema.safeParse(url)
  if (!parsed.success) return failure('invalid_input', 'http 또는 https 주소만 열 수 있습니다.')
  if (options?.signal?.aborted) return failure('cancelled', '요청이 취소되었습니다.')
  try {
    await openUrl(parsed.data)
  } catch {
    return failure('unavailable', '기본 브라우저로 주소를 전달하지 못했습니다.')
  }
  // Handing over the URL says nothing about whether the page loaded.
  return { ok: true, value: { kind: 'url', url: parsed.data, status: 'dispatched' } }
}
