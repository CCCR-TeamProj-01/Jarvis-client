import type { Result } from '../../shared/contracts/common'
import type { AudioObservation } from '../../shared/contracts/tools'

/** Pieces every OS volume adapter needs the same way; reading and writing the OS stay in each one. */

export interface AudioState {
  level: number | null
  muted: boolean | null
}

export const isPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100

/**
 * Reads the state back after a change. `check` says whether it matches the request, or null when
 * the device cannot report the value in question. A match is `confirmed`, a mismatch `unknown`,
 * and a state that could not be read at all (or not judged) is only `dispatched`.
 */
export async function verifyAudio(
  read: () => Promise<Result<AudioState>>,
  check: (state: AudioState) => boolean | null
): Promise<Result<AudioObservation>> {
  const state = await read()
  if (!state.ok)
    return {
      ok: true,
      value: { kind: 'audio', level: null, muted: null, status: 'dispatched' }
    }
  const { level, muted } = state.value
  const matched = check(state.value)
  const status = matched === true ? 'confirmed' : matched === null ? 'dispatched' : 'unknown'
  return { ok: true, value: { kind: 'audio', level, muted, status } }
}
