import { app, shell } from 'electron'
import { stat } from 'node:fs/promises'
import type { Result } from '../../shared/contracts/common'
import { nodeCommandRunner } from '../platform/command-runner'
import { createFolderOpener } from '../platform/folder-opener'
import { MacSystemAudio } from '../platform/macos-system-audio'
import { MacAppControl } from '../platform/macos-app-control'
import { WindowsAppControl } from '../platform/windows-app-control'
import type { AppControlPort } from '../platform/ports'
import { createUnsupportedAppControl } from '../platform/unsupported-app-control'
import { unsupportedSystemAudio } from '../platform/unsupported-system-audio'
import { sleep } from '../sleep'
import { CapabilityRegistry, platformCapabilities } from './capability-registry'
import { RestoreTargetTracker } from './restore-target'
import { ToolExecutor } from './tool-executor'

export interface ToolStack {
  registry: CapabilityRegistry
  appControl: AppControlPort
  executor: ToolExecutor
  restoreTracker: RestoreTargetTracker
}

/** Production wiring for the OS-facing tools. Tests build the pieces with fakes instead. */
export function createToolStack(auth: { requireSignedIn(): Result<unknown> }): ToolStack {
  const platform = process.platform
  const now = () => performance.now()
  // `shell` is read when a URL is opened, not at construction.
  const openUrl = (url: string) => shell.openExternal(url)
  const appControlOptions = {
    runner: nodeCommandRunner,
    openUrl,
    selfPid: process.pid,
    delay: sleep,
    now
  }
  const appControl =
    platform === 'darwin'
      ? new MacAppControl(appControlOptions)
      : platform === 'win32'
        ? new WindowsAppControl(appControlOptions)
        : createUnsupportedAppControl(openUrl)
  const folders = createFolderOpener({
    // The aliases are Electron's own names for the standard folders.
    resolve: (alias) => app.getPath(alias),
    isDirectory: async (path) => (await stat(path)).isDirectory(),
    openPath: (path) => shell.openPath(path)
  })
  const audio =
    platform === 'darwin'
      ? new MacSystemAudio({ runner: nodeCommandRunner })
      : unsupportedSystemAudio
  const registry = new CapabilityRegistry(platformCapabilities(platform))
  const restoreTracker = new RestoreTargetTracker(appControl)
  const executor = new ToolExecutor({
    registry,
    appControl,
    folders,
    audio,
    auth,
    clock: { now },
    restoreTarget: () => restoreTracker.current()
  })
  return { registry, appControl, executor, restoreTracker }
}
