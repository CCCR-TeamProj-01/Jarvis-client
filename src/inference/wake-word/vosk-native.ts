import koffi from 'koffi'
import { WAKE_KEYWORD, WAKE_SAMPLE_RATE } from './protocol'

export interface WakeRecognizer {
  accept(audio: Uint8Array): unknown
  reset(): void
  dispose(): void
}

/** Loaded only in the inference process. No microphone, network or logging of recognised text. */
export class VoskNative implements WakeRecognizer {
  private readonly library: ReturnType<typeof koffi.load>
  private model: unknown = null
  private recognizer: unknown = null
  private closed = false
  private readonly modelFree: (handle: unknown) => void
  private readonly recognizerFree: (handle: unknown) => void
  private readonly acceptWaveform: (handle: unknown, bytes: Uint8Array, count: number) => number
  private readonly result: (handle: unknown) => string
  private readonly partial: (handle: unknown) => string

  constructor(libraryPath: string, modelPath: string) {
    this.library = koffi.load(libraryPath)
    const bind = (definition: string) => this.library.func(definition)
    this.modelFree = bind('void vosk_model_free(void *model)')
    this.recognizerFree = bind('void vosk_recognizer_free(void *recognizer)')
    this.acceptWaveform = bind(
      'int vosk_recognizer_accept_waveform(void *recognizer, const void *data, int length)'
    )
    this.result = bind('const char *vosk_recognizer_result(void *recognizer)')
    this.partial = bind('const char *vosk_recognizer_partial_result(void *recognizer)')
    try {
      bind('void vosk_set_log_level(int level)')(-1)
      this.model = bind('void *vosk_model_new(const char *path)')(modelPath)
      if (!this.model) throw new Error('model unavailable')
      const findWord = bind('int vosk_model_find_word(void *model, const char *word)')
      if (findWord(this.model, WAKE_KEYWORD) < 0)
        throw new Error('required wake vocabulary unavailable')
      this.createRecognizer()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  accept(audio: Uint8Array): unknown {
    if (!this.recognizer && !this.closed) this.createRecognizer()
    if (!this.recognizer) throw new Error('recognizer closed')
    const ended = this.acceptWaveform(this.recognizer, audio, audio.byteLength)
    if (ended < 0) throw new Error('decoder failed')
    return JSON.parse((ended ? this.result : this.partial)(this.recognizer)) as unknown
  }

  reset(): void {
    // vosk_recognizer_reset retains its time offset. A fresh decoder gives each capture a zero
    // timestamp origin, while the much larger acoustic model remains shared and loaded.
    if (this.recognizer) this.recognizerFree(this.recognizer)
    this.recognizer = null
  }

  private createRecognizer(): void {
    // Restricting this model to [keyword, <UNK>] produced a false wake on ordinary Korean.
    // Decode with the full graph and let WakeEngine accept only an exact timed keyword.
    this.recognizer = this.library.func('void *vosk_recognizer_new(void *model, float rate)')(
      this.model,
      WAKE_SAMPLE_RATE
    )
    if (!this.recognizer) throw new Error('recognizer unavailable')
    this.library.func('void vosk_recognizer_set_words(void *recognizer, int enabled)')(
      this.recognizer,
      1
    )
    this.library.func('void vosk_recognizer_set_partial_words(void *recognizer, int enabled)')(
      this.recognizer,
      1
    )
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.recognizer) this.recognizerFree(this.recognizer)
    if (this.model) this.modelFree(this.model)
    this.recognizer = null
    this.model = null
    this.library.unload()
  }
}
