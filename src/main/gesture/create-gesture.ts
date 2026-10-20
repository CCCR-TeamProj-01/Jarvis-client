import { randomUUID } from 'node:crypto'
import { screen, systemPreferences } from 'electron'
import {
  createElectronDisplaySource,
  createFakePointerDriver,
  createLibnutDriver
} from '../platform/libnut-driver'
import { PointerInput } from '../platform/pointer-input'
import type { PointerDriver } from '../platform/pointer-input'
import type { SensorGate } from '../sensors/hardware'
import { GestureController } from './gesture-controller'
import type { HandTrackingSource, InputPermissionPort } from './ports'

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

/** The native pointer library is loaded when the mode first moves the pointer, not at launch. */
function lazyDriver(create: () => PointerDriver): PointerDriver {
  let driver: PointerDriver | null = null
  const get = () => (driver ??= create())
  return {
    moveTo: (point) => get().moveTo(point),
    click: () => get().click(),
    position: () => get().position()
  }
}

/** macOS asks for Accessibility; elsewhere nothing has to be granted. */
function systemPermission(): InputPermissionPort {
  if (process.platform !== 'darwin') return { isGranted: () => true, request: () => undefined }
  return {
    isGranted: () => systemPreferences.isTrustedAccessibilityClient(false),
    request: () => {
      systemPreferences.isTrustedAccessibilityClient(true)
    }
  }
}

export function createGestureController(options: {
  tracking: HandTrackingSource
  gate: SensorGate
  isPackaged: boolean
  env: NodeJS.ProcessEnv
}): GestureController {
  // Development only: leave the real pointer alone and log what would have been done.
  const fake = !options.isPackaged && options.env.JARVIS_FAKE_POINTER === '1'
  const driver = fake ? createFakePointerDriver() : lazyDriver(() => createLibnutDriver(screen))
  return new GestureController({
    tracking: options.tracking,
    pointer: new PointerInput({
      driver,
      displays: createElectronDisplaySource(screen),
      clock: { now: () => performance.now() },
      // Hand tracking updates ~25 times a second; the pointer glides between updates at ~120 Hz.
      glide: { schedule, intervalMs: 8, timeConstantMs: 30 }
    }),
    permission: fake ? { isGranted: () => true, request: () => undefined } : systemPermission(),
    gate: options.gate,
    clock: { now: () => performance.now() },
    schedule,
    createId: randomUUID
  })
}
