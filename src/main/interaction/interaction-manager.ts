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
import type { SpeechSnapshot } from '../../shared/contracts/speech'
import type { SpeechNotice } from '../speech/session/ports'
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

export interface ConversationHandlers {
  start(): Promise<Result<unknown>>
  stop(): Promise<Result<void>>
}

export class InteractionManager implements InteractionPort {
  private snapshot: ClientSnapshot
  private readonly listeners = new Set<(event: UiEvent) => void>()
  private conversation: ConversationHandlers | null = null
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
        // Stopping never needs a sign-in, and an idle conversation is already stopped.
        await this.conversation?.stop()
        return this.accepted()
      case 'gesture.stop':
        return this.accepted()
      case 'conversation.start': {
        if (this.snapshot.auth.phase !== 'signed_in') {
          this.open('login')
          return this.failure('authentication_required', '로그인이 필요합니다.')
        }
        if (!this.conversation)
          return this.failure('unsupported', '아직 사용할 수 없는 기능입니다.')
        const started = await this.conversation.start()
        return started.ok ? this.accepted() : started
      }
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

  /** Connect the voice conversation; until then the commands report themselves unsupported. */
  setConversationHandlers(handlers: ConversationHandlers | null): void {
    this.conversation = handlers
  }

  /** The speech session's state, from which the conversation and request views follow. */
  setSpeechState(speech: SpeechSnapshot, requestId: string | null): void {
    if (this.disposed) return
    const working = speech.phase === 'transcribing' || speech.phase === 'processing'
    this.update({
      speech,
      conversation:
        speech.phase === 'idle'
          ? { phase: 'idle', generation: null }
          : { phase: 'active', generation: speech.generation },
      request:
        working && requestId
          ? { requestId, phase: 'processing' }
          : { requestId: null, phase: 'idle' }
    })
  }

  /** Words for the user from the conversation, as events (they are not part of the state). */
  publishNotice(notice: SpeechNotice): void {
    if (this.disposed) return
    const event: UiEvent | null =
      notice.type === 'transcript'
        ? { type: 'result.available', requestId: notice.requestId, text: `나: ${notice.text}` }
        : notice.type === 'response'
          ? {
              type: 'result.available',
              requestId: notice.requestId,
              text: `자비스: ${notice.text}`
            }
          : { type: 'client.error', error: notice.error }
    this.emit(event)
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
    this.emit({ type: 'state.changed', snapshot: this.getSnapshot() })
  }

  private emit(event: UiEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
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
