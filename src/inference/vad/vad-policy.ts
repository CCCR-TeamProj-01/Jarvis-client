import { z } from 'zod'

/**
 * Timing rules for turning a stream of audio into one utterance. The defaults are provisional
 * and are meant to be tuned once reference devices and a measurement method are agreed
 * (docs/delivery/validation.md); callers pass their own values per session.
 */
export const VadPolicySchema = z.strictObject({
  /** Give up if no speech begins within this time after the VAD starts. */
  startWaitMs: z.number().int().positive(),
  /** Silence that ends an utterance. */
  endSilenceMs: z.number().int().positive(),
  /** An utterance running longer than this is cut and reported as `max_duration`. */
  maxUtteranceMs: z.number().int().positive(),
  /** Audio kept from before the detected start so soft onsets are not clipped. */
  preRollMs: z.number().int().nonnegative(),
  /** Speech shorter than this is treated as noise. */
  minSpeechMs: z.number().int().positive()
})
export type VadPolicy = z.infer<typeof VadPolicySchema>

export const DEFAULT_VAD_POLICY: VadPolicy = {
  startWaitMs: 6_000,
  endSilenceMs: 700,
  maxUtteranceMs: 15_000,
  preRollMs: 300,
  minSpeechMs: 150
}
