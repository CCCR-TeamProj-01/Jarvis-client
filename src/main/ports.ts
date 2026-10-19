/** Inject a monotonic clock; timestamps from other processes are not comparable to it. */
export interface MonotonicClock {
  now(): number
}

/** Process-local options. Neither AbortSignal nor the clock is serialized over IPC. */
export interface LocalExecutionOptions {
  signal?: AbortSignal
  deadlineMs?: number
}
