import type { AuthSnapshot } from '../../shared/contracts/auth'
import type {
  ShortcutSnapshot,
  TraySnapshot,
  WindowMaterial
} from '../../shared/contracts/application'
import type { ClientError, Result } from '../../shared/contracts/common'
import { ClientSnapshotSchema } from '../../shared/contracts/interaction'
import type {
  ClientSnapshot,
  CommandReceipt,
  UiCommand,
  UiEvent
} from '../../shared/contracts/interaction'
import type { SensorSnapshot } from '../../shared/contracts/sensors'
import type { ActivationSource, InteractionPort } from './ports'
import type { LocalExecutionOptions } from '../ports'

interface InteractionOptions {
  auth: AuthSnapshot
  accelerator: string
  createId(): string
  now(): number
  showWindow(): void
  quit(): void
}

/** No conversation, request, speech, gesture or sensor is running. */
function idleSubsystems(): Pick<
  ClientSnapshot,
  'conversation' | 'request' | 'speech' | 'gesture' | 'sensors'
> {
  return {
    conversation: { phase: 'idle', generation: null },
    request: { requestId: null, phase: 'idle' },
    speech: { phase: 'idle', generation: null },
    gesture: { phase: 'off', generation: null, activeHandId: null, displayId: null },
    sensors: []
  }
}

export class InteractionManager implements InteractionPort {
  private snapshot: ClientSnapshot
  private readonly listeners = new Set<(event: UiEvent) => void>()
  private disposed = false

  constructor(private readonly options: InteractionOptions) {
    this.snapshot = ClientSnapshotSchema.parse({
      revision: 0,
      application: {
        windowMaterial: 'opaque',
        shortcut: { status: 'pending', accelerator: options.accelerator },
        tray: { status: 'pending' }
      },
      auth: options.auth,
      recognitionPaused: false,
      ...idleSubsystems(),
      screen: options.auth.phase === 'signed_in' ? 'hidden' : 'login',
      connection: 'offline'
    })
  }

  activateConversation(_source: ActivationSource): Promise<Result<CommandReceipt>> {
    return this.dispatch({ type: 'conversation.start' })
  }

  async dispatch(
    command: UiCommand,
    options?: LocalExecutionOptions
  ): Promise<Result<CommandReceipt>> {
    if (this.disposed || options?.signal?.aborted)
      return this.failure('cancelled', '요청이 취소되었습니다.')
    if (options?.deadlineMs !== undefined) {
      if (!Number.isFinite(options.deadlineMs))
        return this.failure('invalid_input', '요청 기한이 올바르지 않습니다.')
      if (options.deadlineMs <= this.options.now())
        return this.failure('expired', '요청 시간이 지났습니다.')
    }
    switch (command.type) {
      case 'app.quit':
        this.options.quit()
        return this.accepted()
      case 'auth.open':
        if (this.snapshot.auth.phase === 'signed_in')
          return this.failure('conflict', '이미 로그인되어 있습니다.')
        this.open(command.screen)
        return this.accepted()
      case 'conversation.stop':
      case 'gesture.stop':
        // No subsystem is started by this foundation. Stopping an idle subsystem is safe.
        return this.accepted()
      case 'recognition.pause':
        if (!this.snapshot.recognitionPaused) this.update({ recognitionPaused: true })
        return this.accepted()
      case 'recognition.resume':
        // Resuming is a protected action: before sign-in it leads to the login screen instead.
        if (this.snapshot.auth.phase === 'signed_in') {
          if (this.snapshot.recognitionPaused) this.update({ recognitionPaused: false })
          return this.accepted()
        }
        this.open('login')
        return this.failure('authentication_required', '로그인이 필요합니다.')
      default:
        if (this.snapshot.auth.phase !== 'signed_in') {
          this.open('login')
          return this.failure('authentication_required', '로그인이 필요합니다.')
        }
        return this.failure('unsupported', '아직 사용할 수 없는 기능입니다.')
    }
  }

  getSnapshot(): ClientSnapshot {
    return structuredClone(this.snapshot)
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    if (this.disposed) return () => undefined
    const receive = (event: UiEvent) => listener(event)
    this.listeners.add(receive)
    return () => {
      this.listeners.delete(receive)
    }
  }

  /**
   * Main-owned authentication state. Leaving `signed_in` drops everything tied to the previous
   * account, so nothing from it can be shown to or acted on by the next one.
   */
  setAuthSnapshot(auth: AuthSnapshot): void {
    if (this.disposed) return
    const previous = this.snapshot.auth
    if (JSON.stringify(previous) === JSON.stringify(auth)) return
    const authScreen = this.snapshot.screen === 'login' || this.snapshot.screen === 'signup'
    if (auth.phase === 'signed_in') {
      this.update({ auth, screen: authScreen ? 'status' : this.snapshot.screen })
      return
    }
    this.update({
      auth,
      ...idleSubsystems(),
      screen: authScreen ? this.snapshot.screen : 'login'
    })
    this.options.showWindow()
  }

  /** Published by the sensor layer; Main is the only writer. */
  setSensors(sensors: SensorSnapshot[]): void {
    if (this.disposed) return
    if (JSON.stringify(this.snapshot.sensors) === JSON.stringify(sensors)) return
    this.update({ sensors })
  }

  setShortcutState(shortcut: ShortcutSnapshot): void {
    if (!this.disposed) this.update({ application: { ...this.snapshot.application, shortcut } })
  }

  setTrayState(tray: TraySnapshot): void {
    if (!this.disposed) this.update({ application: { ...this.snapshot.application, tray } })
  }

  setWindowMaterial(windowMaterial: WindowMaterial): void {
    if (!this.disposed && this.snapshot.application.windowMaterial !== windowMaterial)
      this.update({ application: { ...this.snapshot.application, windowMaterial } })
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private open(screen: 'login' | 'signup'): void {
    if (this.snapshot.screen !== screen) this.update({ screen })
    this.options.showWindow()
  }

  private update(patch: Partial<ClientSnapshot>): void {
    this.snapshot = ClientSnapshotSchema.parse({
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1
    })
    for (const listener of [...this.listeners]) {
      try {
        listener({ type: 'state.changed', snapshot: this.getSnapshot() })
      } catch {
        /* Observers cannot prevent state transitions or other observers. */
      }
    }
  }

  private accepted(): Result<CommandReceipt> {
    return { ok: true, value: { commandId: this.options.createId(), status: 'accepted' } }
  }

  private failure(code: ClientError['code'], message: string): Result<never> {
    return { ok: false, error: { code, message } }
  }
}
