import type { WindowReference } from '../../shared/contracts/tools'
import type { AppControlPort } from '../platform/ports'

/**
 * Remembers where the user was just before Jarvis was called, so "go back" has a target. Capture
 * runs before Jarvis takes the foreground; the reference is checked again when it is used.
 */
export class RestoreTargetTracker {
  private target: WindowReference | null = null
  private capturing = 0

  constructor(private readonly appControl: Pick<AppControlPort, 'getForegroundWindow'>) {}

  async capture(): Promise<void> {
    const ticket = ++this.capturing
    const foreground = await this.appControl.getForegroundWindow().catch(() => null)
    // A newer capture, or a clear, supersedes this one.
    if (ticket !== this.capturing) return
    // Keep the previous target if nothing usable is in front (for example Jarvis itself).
    if (foreground?.ok && foreground.value) this.target = foreground.value
  }

  current(): WindowReference | null {
    return this.target ? { ...this.target } : null
  }

  /** Account change or sign-out: the old user's context must not carry over. */
  clear(): void {
    this.capturing += 1
    this.target = null
  }
}
