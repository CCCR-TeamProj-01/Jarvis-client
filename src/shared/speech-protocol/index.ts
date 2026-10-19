/** Shared client-side shape for completed utterances and server speech results. */
export const SPEECH_PROTOCOL_VERSION = 1 as const

export interface SpeechRequestContext {
  protocolVersion: typeof SPEECH_PROTOCOL_VERSION
  conversationId: string
  requestId: string
  speechSessionId: string
  stateVersion: number
  expiresAt: string
}

export interface SpeechAudioFormat {
  encoding: 'pcm_s16le'
  sampleRateHz: number
  channels: 1
}

export interface CompletedUtterance {
  context: SpeechRequestContext
  format: SpeechAudioFormat
  durationMs: number
  /** Binary payload; never serialize into a JSON control message or log. */
  audio: Uint8Array
}

export type TranscriptionResult =
  | { context: SpeechRequestContext; status: 'transcribed'; text: string }
  | { context: SpeechRequestContext; status: 'empty' }
  | { context: SpeechRequestContext; status: 'failed'; errorCode: string }

export interface ServerSpeechResponse {
  context: SpeechRequestContext
  text: string
  /** Missing audio means the client displays the confirmed text result. */
  audio?: {
    mimeType: string
    bytes: Uint8Array
  }
}
