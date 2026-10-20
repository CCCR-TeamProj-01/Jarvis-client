import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => ({ content: null as Uint8Array | null, requested: '' }))
vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    files.requested = path
    if (!files.content) throw new Error('ENOENT')
    return Buffer.from(files.content)
  }
}))
vi.mock('../../src/main/models', () => ({ modelPath: (file: string) => `/models/${file}` }))

import { HAND_MODEL_FILE, loadHandModel } from '../../src/main/gesture/hand-model'

beforeEach(() => {
  files.content = null
  files.requested = ''
})

describe('loadHandModel', () => {
  it('reads the model file as bytes', async () => {
    files.content = new Uint8Array([1, 2, 3])
    const result = await loadHandModel()
    expect(files.requested).toBe(`/models/${HAND_MODEL_FILE}`)
    expect(result).toEqual({ ok: true, value: new Uint8Array([1, 2, 3]) })
  })

  it('names the fix when the model is missing', async () => {
    const result = await loadHandModel()
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable', message: expect.stringContaining('pnpm models:fetch') }
    })
  })
})
