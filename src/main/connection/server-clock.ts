/**
 * How far the server's clock is from this machine's, learned from the `Date` header of its
 * responses. Command deadlines are judged on server timestamps, so they need this correction.
 * The header has one-second resolution; that is accurate enough for a deadline of a minute.
 */
export class ServerClock {
  private offset: number | null = null

  /** `receivedAtMs` is this machine's wall clock when the response arrived. */
  observe(dateHeader: string | null, receivedAtMs: number): void {
    if (dateHeader === null) return
    const serverMs = Date.parse(dateHeader)
    if (!Number.isFinite(serverMs)) return
    this.offset = serverMs - receivedAtMs
  }

  /** Server time minus local time in milliseconds, or null before any response was seen. */
  get offsetMs(): number | null {
    return this.offset
  }

  /** The server's wall-clock time at a local wall-clock moment; null when the offset is unknown. */
  serverTimeAt(localMs: number): number | null {
    return this.offset === null ? null : localMs + this.offset
  }
}
