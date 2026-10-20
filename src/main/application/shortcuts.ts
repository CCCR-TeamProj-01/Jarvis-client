import { globalShortcut } from 'electron'
import { DEFAULT_CALL_SHORTCUT, GESTURE_TOGGLE_SHORTCUT } from '../../shared/contracts/application'
import type { ShortcutSnapshot } from '../../shared/contracts/application'

export { DEFAULT_CALL_SHORTCUT, GESTURE_TOGGLE_SHORTCUT }

interface ShortcutOptions {
  /** The call: start a conversation. */
  call(): void
  toggleGesture(): void
  /** What the window shows about the call shortcut (it falls back to the tray when taken). */
  report(state: ShortcutSnapshot): void
}

function register(accelerator: string, handler: () => void): boolean {
  try {
    return globalShortcut.register(accelerator, handler)
  } catch {
    return false
  }
}

/** Registers the global shortcuts and returns the function that gives them back. */
export function registerShortcuts({ call, toggleGesture, report }: ShortcutOptions): () => void {
  const callRegistered = register(DEFAULT_CALL_SHORTCUT, call)
  const gestureRegistered = register(GESTURE_TOGGLE_SHORTCUT, toggleGesture)
  report(
    callRegistered
      ? { status: 'registered', accelerator: DEFAULT_CALL_SHORTCUT }
      : {
          status: 'unavailable',
          accelerator: DEFAULT_CALL_SHORTCUT,
          error: {
            code: 'conflict',
            message: '호출 단축키를 등록하지 못했습니다. 트레이에서 창을 열어 주세요.'
          }
        }
  )
  let released = false
  return () => {
    if (released) return
    released = true
    // Each is given back on its own, so one that fails to release does not keep the other.
    const failures: unknown[] = []
    for (const [registered, accelerator] of [
      [callRegistered, DEFAULT_CALL_SHORTCUT],
      [gestureRegistered, GESTURE_TOGGLE_SHORTCUT]
    ] as const) {
      if (!registered) continue
      try {
        globalShortcut.unregister(accelerator)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw failures[0]
  }
}
