import { nativeImage } from 'electron'
import type { NativeImage } from 'electron'

// A 32px transparent J glyph; packaged apps do not need an external asset path.
const ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQElEQVR4nGNgGAWjYDADi70//lOKRx0wtB1AqYPpavmoA0YdMOqA4ekAUg0cdcDwd8CA1oQDXgWPOmAUjIJhCwCleRyrH2Q6uQAAAABJRU5ErkJggg=='

export function createTrayIcon(): NativeImage {
  const icon = nativeImage.createFromBuffer(Buffer.from(ICON_PNG, 'base64'), { scaleFactor: 2 })
  if (icon.isEmpty()) throw new Error('Tray icon could not be decoded')
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  return icon
}
