import { app, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import type { MediaPermissionPort, SensorGate } from './hardware'
import { MediaBridge, MediaSensorHardware } from './media-bridge'
import { MediaWindow } from './media-window'
import { createSystemMediaPermissions, fakeMediaPermissions } from './media-permissions'
import { SensorManager } from './sensor-manager'

export interface SensorStack {
  sensors: SensorManager
  bridge: MediaBridge
  window: MediaWindow
  hardware: MediaSensorHardware
}

interface SensorStackOptions {
  mediaEntryUrl: string
  mediaPreloadPath: string
  gate: SensorGate
  isQuitting(): boolean
}

/** Chromium fake devices for development; never active in a packaged app. */
export function isFakeMediaEnabled(): boolean {
  return !app.isPackaged && process.env.JARVIS_FAKE_MEDIA === '1'
}

export function createSensorStack(options: SensorStackOptions): SensorStack {
  const schedule = (callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return () => clearTimeout(timer)
  }
  let hardware: MediaSensorHardware | null = null
  const window = new MediaWindow({
    entryUrl: options.mediaEntryUrl,
    preloadPath: options.mediaPreloadPath,
    isQuitting: options.isQuitting,
    onGone: () => {
      bridge.rendererLost()
      hardware?.rendererLost()
    }
  })
  const bridge = new MediaBridge({
    send: (envelope) => window.send(envelope),
    createId: randomUUID,
    schedule
  })
  hardware = new MediaSensorHardware(bridge)
  const permissions: MediaPermissionPort = isFakeMediaEnabled()
    ? fakeMediaPermissions
    : createSystemMediaPermissions(systemPreferences, process.platform)
  const sensors = new SensorManager({
    hardware,
    permissions,
    gate: options.gate,
    clock: { now: () => performance.now() },
    createId: randomUUID
  })
  return { sensors, bridge, window, hardware }
}
