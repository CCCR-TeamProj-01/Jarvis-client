/**
 * Waits `ms`, or less when the signal aborts (it then returns at once, without an error: callers
 * check the signal themselves). The timer never keeps the app alive. The signal is optional.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    timer.unref()
    signal?.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}
