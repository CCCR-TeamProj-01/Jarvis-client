import { randomUUID } from 'node:crypto'
import type { Result } from '../../shared/contracts/common'
import type { ServerClient } from '../connection/server-client'
import type { AppControlPort } from '../platform/ports'
import type { LocalFilesPort } from '../settings/ports'
import { sleep } from '../sleep'
import { CollectionConsentApi } from './collection-consent'
import { CommandApi } from './command-api'
import { CommandJournal } from './command-journal'
import { CommandService } from './command-service'
import type { CommandServiceOptions } from './command-service'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The client for server calls; null when there is no usable server. */
  api: ServerClient | null
  executor: CommandServiceOptions['executor']
  files: Pick<LocalFilesPort, 'read' | 'replace'>
  /** Tells which apps are running, for the activity reported with a result. */
  appControl: Pick<AppControlPort, 'list'>
  platform: NodeJS.Platform
}

/** The OS IDs of the apps the OS says are running; apps that are stopped or whose state is unknown are left out. */
export function runningAppIds(
  appControl: Pick<AppControlPort, 'list'>
): (signal?: AbortSignal) => Promise<Result<string[]>> {
  return async (signal) => {
    const apps = await appControl.list(signal ? { signal } : undefined)
    if (!apps.ok) return { ok: false, error: apps.error }
    return {
      ok: true,
      value: apps.value.filter((app) => app.state === 'running').map((app) => app.appId)
    }
  }
}

/**
 * The service exists only with a real server and a real login. The development sign-in stand-in
 * (JARVIS_DEV_AUTH=1) has no session the server would accept, so polling with it would only fail.
 */
export function createCommandService({
  isPackaged,
  env,
  api,
  executor,
  files,
  appControl,
  platform
}: Selection): CommandService | null {
  if (!api) return null
  if (!isPackaged && env.JARVIS_DEV_AUTH === '1') return null
  return new CommandService({
    api: new CommandApi(api),
    journal: new CommandJournal({ files, now: Date.now }),
    executor,
    platform,
    activity: {
      consent: new CollectionConsentApi(api),
      runningApps: runningAppIds(appControl),
      createId: () => `act_${randomUUID()}`
    },
    now: Date.now,
    clock: api.clock,
    sleep,
    // Fixed sentences only, so nothing about a command can reach the log.
    log: (message) => console.warn(`[commands] ${message}`)
  })
}
