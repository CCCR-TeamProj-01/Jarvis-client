import { app, shell } from 'electron'
import { stat } from 'node:fs/promises'
import type { Result } from '../../shared/contracts/common'
import { nodeCommandRunner } from '../platform/command-runner'
import { createFolderOpener } from '../platform/folder-opener'
import { MacAppControl } from '../platform/macos-app-control'
import type { AppControlPort } from '../platform/ports'
import { createUnsupportedAppControl } from '../platform/unsupported-app-control'
import { CapabilityRegistry, platformCapabilities } from './capability-registry'
import { RestoreTargetTracker } from './restore-target'
import { ToolExecutor } from './tool-executor'

export interface ToolStack {
  registry: CapabilityRegistry
  appControl: AppControlPort
  executor: ToolExecutor
  restoreTracker: RestoreTargetTracker
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })

/** Production wiring for the OS-facing tools. Tests build the pieces with fakes instead. */
export function createToolStack(auth: { requireSignedIn(): Result<unknown> }): ToolStack {
  const platform = process.platform
  const now = () => performance.now()
  // `shell` is read when a URL is opened, not at construction.
  const openUrl = (url: string) => shell.openExternal(url)
  const appControl =
    platform === 'darwin'
      ? new MacAppControl({
          runner: nodeCommandRunner,
          openUrl,
          selfPid: process.pid,
          delay,
          now
        })
      : createUnsupportedAppControl(openUrl)
  const folders = createFolderOpener({
    // The aliases are Electron's own names for the standard folders.
    resolve: (alias) => app.getPath(alias),
    isDirectory: async (path) => (await stat(path)).isDirectory(),
    openPath: (path) => shell.openPath(path)
  })
  const registry = new CapabilityRegistry(platformCapabilities(platform))
  const restoreTracker = new RestoreTargetTracker(appControl)
  const executor = new ToolExecutor({
    registry,
    appControl,
    folders,
    auth,
    clock: { now },
    restoreTarget: () => restoreTracker.current()
  })
  return { registry, appControl, executor, restoreTracker }
}
