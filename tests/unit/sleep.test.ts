import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sleep } from '../../src/main/sleep'

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false
    void promise.then(() => (done = true))
    await Promise.resolve()
    await Promise.resolve()
    return done
  }

  it('waits for the time given, no less', async () => {
    const waiting = sleep(1000)
    vi.advanceTimersByTime(999)
    expect(await settled(waiting)).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('works without a signal', async () => {
    const waiting = sleep(50, undefined)
    vi.advanceTimersByTime(50)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('returns early, without an error, when the signal aborts', async () => {
    const abort = new AbortController()
    const waiting = sleep(60_000, abort.signal)
    vi.advanceTimersByTime(10)
    expect(await settled(waiting)).toBe(false)
    abort.abort()
    await expect(waiting).resolves.toBeUndefined()
  })

  it('returns at once for a signal that has already aborted, and starts no timer', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(sleep(60_000, abort.signal)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer and no listener behind, whether it ran out or was aborted', async () => {
    const ran = new AbortController()
    const removed = vi.spyOn(ran.signal, 'removeEventListener')
    const first = sleep(10, ran.signal)
    vi.advanceTimersByTime(10)
    await first
    expect(vi.getTimerCount()).toBe(0)
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))

    const aborted = new AbortController()
    const second = sleep(60_000, aborted.signal)
    aborted.abort()
    await second
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never keeps the app alive on its own', () => {
    const unref = vi.fn<() => void>()
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((handler: () => void) => ({ unref, handler })) as never)
    void sleep(1000)
    expect(unref).toHaveBeenCalledOnce()
    spy.mockRestore()
  })
})
