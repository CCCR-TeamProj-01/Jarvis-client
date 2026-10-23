import { describe, expect, it, vi } from 'vitest'
import {
  previewEncoder,
  PREVIEW_WIDTH
} from '../../src/renderer/media/hand-tracking/preview-encoder'
import type { PreviewCanvas } from '../../src/renderer/media/hand-tracking/preview-encoder'

const image = (width: number, height: number) => ({ width, height }) as unknown as ImageBitmap

function setup(jpeg: Uint8Array | null | Error = new Uint8Array([1, 2, 3])) {
  const order: string[] = []
  const created: { width: number; height: number }[] = []
  const canvas: PreviewCanvas = {
    width: 0,
    height: 0,
    drawImage: vi.fn<PreviewCanvas['drawImage']>(() => {
      order.push('draw')
    }),
    toJpeg: vi.fn<PreviewCanvas['toJpeg']>(async () => {
      order.push('encode')
      if (jpeg instanceof Error) throw jpeg
      return jpeg
    })
  }
  const encoder = previewEncoder((width, height) => {
    created.push({ width, height })
    return canvas
  })
  return { encoder, canvas, order, created }
}

describe('the preview encoder', () => {
  it('scales a camera picture down to the preview width, keeping its shape', async () => {
    const t = setup()
    const picture = await t.encoder.capture(image(1280, 720))
    expect(t.created).toEqual([{ width: PREVIEW_WIDTH, height: 180 }])
    expect(picture).toEqual({ width: PREVIEW_WIDTH, height: 180, jpeg: new Uint8Array([1, 2, 3]) })
    expect(t.canvas.drawImage).toHaveBeenCalledWith(expect.anything(), PREVIEW_WIDTH, 180)
  })

  it('does not enlarge a small picture', async () => {
    const t = setup()
    expect(await t.encoder.capture(image(160, 120))).toMatchObject({ width: 160, height: 120 })
  })

  it('draws at once, before the encoding the picture waits for', async () => {
    const t = setup()
    const pending = t.encoder.capture(image(640, 480))
    // Nothing has been awaited yet, and the picture is already on the canvas.
    expect(t.order).toEqual(['draw', 'encode'])
    await pending
  })

  it('gives nothing, and does not throw, for a picture it cannot make', async () => {
    expect(await setup(null).encoder.capture(image(640, 480))).toBeNull()
    expect(await setup(new Uint8Array(0)).encoder.capture(image(640, 480))).toBeNull()
    expect(await setup(new Error('encode failed')).encoder.capture(image(640, 480))).toBeNull()
    expect(await setup().encoder.capture(image(0, 0))).toBeNull()
    const noCanvas = previewEncoder(() => null)
    expect(await noCanvas.capture(image(640, 480))).toBeNull()
    const broken = previewEncoder(() => {
      throw new Error('no canvas')
    })
    expect(await broken.capture(image(640, 480))).toBeNull()
  })

  it('never makes a picture shorter than the schema allows', async () => {
    const t = setup()
    expect(await t.encoder.capture(image(2000, 10))).toMatchObject({ height: 16 })
  })
})
