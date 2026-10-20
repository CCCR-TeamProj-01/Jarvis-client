import { createRequire } from 'node:module'
import type { DisplayBounds } from '../../shared/contracts/gesture'
import type { DisplaySource, PointerDriver } from './pointer-input'

/** The part of libnut used here. */
interface Libnut {
  moveMouse(x: number, y: number): void
  mouseClick(button?: string, double?: boolean): void
  getMousePos(): { x: number; y: number }
  setMouseDelay?(delay: number): void
}

/** The display API of Electron that matters here, so it can be replaced in tests. */
export interface ElectronScreen {
  getAllDisplays(): {
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }[]
  getPrimaryDisplay(): { id: number }
  dipToScreenPoint?(point: { x: number; y: number }): { x: number; y: number }
  screenToDipPoint?(point: { x: number; y: number }): { x: number; y: number }
}

export function createElectronDisplaySource(screen: ElectronScreen): DisplaySource {
  return {
    list(): DisplayBounds[] {
      const primary = screen.getPrimaryDisplay().id
      return screen
        .getAllDisplays()
        .map((display) => ({
          displayId: String(display.id),
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
          scaleFactor: display.scaleFactor
        }))
        .sort(
          (a, b) =>
            Number(b.displayId === String(primary)) - Number(a.displayId === String(primary))
        )
    }
  }
}

/**
 * libnut loads a native addon, so it is required lazily and only for the platform that has one.
 * macOS positions are the logical points the rest of the app uses; on Windows libnut works in
 * physical pixels, so points are converted through Electron's DPI mapping.
 */
export function createLibnutDriver(
  screen: ElectronScreen,
  platform: NodeJS.Platform = process.platform,
  load: (name: string) => Libnut = (name) => createRequire(__filename)(name) as Libnut
): PointerDriver {
  const moduleName =
    platform === 'darwin'
      ? '@nut-tree-fork/libnut-darwin'
      : platform === 'win32'
        ? '@nut-tree-fork/libnut-win32'
        : null
  if (!moduleName) throw new Error('Pointer input is not supported on this platform')
  const libnut = load(moduleName)
  // The default pause after each call (a few ms) would throttle the pointer for no benefit.
  libnut.setMouseDelay?.(0)
  const toNative = (point: { x: number; y: number }) =>
    platform === 'win32' && screen.dipToScreenPoint ? screen.dipToScreenPoint(point) : point
  const toLogical = (point: { x: number; y: number }) =>
    platform === 'win32' && screen.screenToDipPoint ? screen.screenToDipPoint(point) : point
  return {
    moveTo(point) {
      const native = toNative(point)
      libnut.moveMouse(Math.round(native.x), Math.round(native.y))
    },
    click() {
      libnut.mouseClick('left', false)
    },
    position() {
      return toLogical(libnut.getMousePos())
    }
  }
}

/** Development stand-in that leaves the real pointer alone and says what it would have done. */
export function createFakePointerDriver(
  log: (line: string) => void = console.log,
  now: () => number = () => Date.now()
): PointerDriver {
  let position = { x: 0, y: 0 }
  let lastMoveLogged = 0
  return {
    moveTo(point) {
      position = point
      // Moves arrive many times a second; a few lines are enough to see them.
      if (now() - lastMoveLogged < 250) return
      lastMoveLogged = now()
      log(`POINTER_FAKE move ${Math.round(point.x)} ${Math.round(point.y)}`)
    },
    click() {
      log(`POINTER_FAKE click ${Math.round(position.x)} ${Math.round(position.y)}`)
    },
    position: () => position
  }
}
