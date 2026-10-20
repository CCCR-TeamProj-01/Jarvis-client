import type { ClientError, Result } from '../../../shared/contracts/common'
import type { CompletedUtterance } from '../../../shared/contracts/speech'
import type { LocalExecutionOptions } from '../../ports'
import type {
  AssistantPort,
  AssistantReply,
  AssistantRespondOptions,
  TurnContext
} from '../../conversation/ports'
import { runDevIntent } from './dev-intents'
import type { RemoteSpeechPort, SpeechTurn, Transcription } from './ports'
import { createToneWav } from './tone'

export interface DevRemoteSpeechOptions {
  /** After this many answered turns the reply asks to end the conversation. */
  endAfterTurns?: number
  latencyMs?: number
  /** Awaited before each call; lets a test hold a request open. */
  gate?(step: 'transcribe' | 'respond'): Promise<void>
  /** Make the next call of a step fail with this error. */
  failNext?: Partial<Record<'transcribe' | 'respond', ClientError>>
  /** Make the next transcription empty. */
  emptyNext?: boolean
  /** Reply without audio, as when speech generation fails. */
  withoutAudio?: boolean
}

/**
 * Development stand-in for the server's STT and assistant (both ports). It never leaves the process, keeps nothing and
 * answers with fixed text and a short tone. The audio it receives is only measured, not kept.
 */
export class DevRemoteSpeech implements RemoteSpeechPort, AssistantPort {
  readonly calls: {
    step: 'transcribe' | 'respond'
    turn: SpeechTurn | TurnContext
    bytes?: number
  }[] = []
  private turns = 0

  constructor(private readonly options: DevRemoteSpeechOptions = {}) {}

  async transcribe(
    turn: SpeechTurn,
    utterance: CompletedUtterance,
    execution?: LocalExecutionOptions
  ): Promise<Result<Transcription>> {
    this.calls.push({ step: 'transcribe', turn, bytes: utterance.audio.byteLength })
    const early = await this.enter('transcribe', execution)
    if (early) return early
    if (this.options.emptyNext) {
      this.options.emptyNext = false
      return { ok: true, value: { status: 'empty' } }
    }
    const seconds = (utterance.sampleCount / utterance.format.sampleRateHz).toFixed(1)
    return {
      ok: true,
      value: { status: 'transcribed', text: `(개발용 인식) ${seconds}초 길이의 발화` }
    }
  }

  async respond(
    turn: TurnContext,
    text: string,
    execution?: AssistantRespondOptions
  ): Promise<Result<AssistantReply>> {
    this.calls.push({ step: 'respond', turn })
    const early = await this.enter('respond', execution)
    if (early) return early
    // With tools available, plain requests ("사파리 열어줘") are carried out and answered from the results.
    const performed = execution?.tools ? await runDevIntent(text, execution.tools) : null
    if (execution?.signal?.aborted)
      return { ok: false, error: { code: 'cancelled', message: '요청이 취소되었습니다.' } }
    this.turns += 1
    const end = this.options.endAfterTurns !== undefined && this.turns >= this.options.endAfterTurns
    return {
      ok: true,
      value: {
        text: performed ?? `(개발용 응답) "${text}"을 받았어요.`,
        ...(this.options.withoutAudio
          ? {}
          : { audio: { mimeType: 'audio/wav', bytes: createToneWav({}) } }),
        ...(end ? { endConversation: true } : {})
      }
    }
  }

  private async enter(
    step: 'transcribe' | 'respond',
    execution?: LocalExecutionOptions
  ): Promise<Result<never> | null> {
    if (execution?.signal?.aborted)
      return { ok: false, error: { code: 'cancelled', message: '요청이 취소되었습니다.' } }
    if (this.options.latencyMs) await new Promise((r) => setTimeout(r, this.options.latencyMs))
    await this.options.gate?.(step)
    if (execution?.signal?.aborted)
      return { ok: false, error: { code: 'cancelled', message: '요청이 취소되었습니다.' } }
    const injected = this.options.failNext?.[step]
    if (injected) {
      delete this.options.failNext?.[step]
      return { ok: false, error: injected }
    }
    return null
  }
}
