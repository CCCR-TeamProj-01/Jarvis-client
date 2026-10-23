import type { PreviewEncoder, PreviewPicture } from './hand-tracking-pipeline'

/** The surface a picture is drawn on, so encoding can be tested without a browser. */
export interface PreviewCanvas {
  width: number
  height: number
  drawImage(image: ImageBitmap, width: number, height: number): void
  toJpeg(quality: number): Promise<Uint8Array | null>
}

/** The widest a preview is; a picture to look at on the screen, not the camera's own size. */
export const PREVIEW_WIDTH = 320
const QUALITY = 0.6

/**
 * Makes preview JPEGs through a canvas of its own. The picture is drawn as soon as `capture` is
 * called (the bitmap is closed by detection right after), and the JPEG is encoded afterwards. A
 * picture that cannot be drawn or encoded gives null; nothing here throws.
 */
export function previewEncoder(
  createCanvas: (width: number, height: number) => PreviewCanvas | null
): PreviewEncoder {
  return {
    capture(image: ImageBitmap): Promise<PreviewPicture | null> {
      try {
        if (!(image.width > 0 && image.height > 0)) return Promise.resolve(null)
        const width = Math.min(PREVIEW_WIDTH, image.width)
        const height = Math.max(16, Math.round((image.height / image.width) * width))
        const canvas = createCanvas(width, height)
        if (!canvas) return Promise.resolve(null)
        canvas.drawImage(image, width, height)
        return canvas.toJpeg(QUALITY).then(
          (jpeg) => (jpeg && jpeg.byteLength > 0 ? { width, height, jpeg } : null),
          () => null
        )
      } catch {
        return Promise.resolve(null)
      }
    }
  }
}

/** The browser's offscreen canvas as the preview surface. */
export function createCanvasPreviewEncoder(): PreviewEncoder {
  return previewEncoder((width, height) => {
    if (typeof OffscreenCanvas === 'undefined') return null
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return null
    return {
      width,
      height,
      drawImage: (image, drawWidth, drawHeight) =>
        context.drawImage(image, 0, 0, drawWidth, drawHeight),
      toJpeg: async (quality) => {
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
        return new Uint8Array(await blob.arrayBuffer())
      }
    }
  })
}
