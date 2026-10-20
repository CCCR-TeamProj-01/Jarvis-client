import { readFile } from 'node:fs/promises'
import type { Result } from '../../shared/contracts/common'
import { modelPath } from '../models'

export const HAND_MODEL_FILE = 'hand_landmarker.task'

/** The hand landmark model's bytes, read by Main so the media page needs no file access. */
export async function loadHandModel(): Promise<Result<Uint8Array>> {
  try {
    return { ok: true, value: new Uint8Array(await readFile(modelPath(HAND_MODEL_FILE))) }
  } catch {
    // A missing model is a setup problem to name clearly rather than a mysterious engine failure.
    return {
      ok: false,
      error: {
        code: 'unavailable',
        message: '손 인식 모델이 없습니다. pnpm models:fetch로 내려받아 주세요.'
      }
    }
  }
}
