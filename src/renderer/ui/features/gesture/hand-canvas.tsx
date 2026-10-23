import { useEffect, useRef } from 'react'
import type { DiagnosticsFrame, Thresholds } from '../../../../shared/contracts/gesture-diagnostics'
import { drawHands } from './hand-draw'
import { shouldPaint } from './recognition-model'

interface HandCanvasProps {
  frame: DiagnosticsFrame
  thresholds: Thresholds
  /** Camera pictures are coming, so a frame without one is not drawn. */
  pictures: boolean
}

/** What the canvas shows before the first picture, and when pictures cannot be made. */
const FALLBACK = { width: 640, height: 360 }

/**
 * The camera picture with the hands drawn on it, like looking in a mirror (the canvas is flipped as
 * a whole, so the picture and the drawing stay together). A frame is drawn once its picture has
 * been decoded; one that was overtaken by a newer frame while decoding is skipped, never drawn late.
 */
export function HandCanvas({ frame, thresholds, pictures }: HandCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawn = useRef(-1)
  const size = useRef(FALLBACK)

  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let live = true
    const paint = (bitmap: ImageBitmap | null) => {
      if (!live || frame.sequence <= drawn.current) {
        bitmap?.close()
        return
      }
      drawn.current = frame.sequence
      if (bitmap) size.current = { width: bitmap.width, height: bitmap.height }
      if (canvas.width !== size.current.width || canvas.height !== size.current.height) {
        canvas.width = size.current.width
        canvas.height = size.current.height
      }
      context.fillStyle = '#0f172a'
      context.fillRect(0, 0, canvas.width, canvas.height)
      if (bitmap) {
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        bitmap.close()
      }
      drawHands(context, frame.hands, canvas.width, canvas.height, thresholds)
    }
    if (!frame.picture) {
      if (shouldPaint(frame, pictures, drawn.current >= 0)) paint(null)
      return () => {
        live = false
      }
    }
    const blob = new Blob([frame.picture.jpeg as BlobPart], { type: 'image/jpeg' })
    void createImageBitmap(blob).then(
      (bitmap) => paint(bitmap),
      () => paint(null)
    )
    return () => {
      live = false
    }
  }, [frame, thresholds, pictures])

  return (
    <canvas ref={ref} className="hand-canvas" width={FALLBACK.width} height={FALLBACK.height} />
  )
}
