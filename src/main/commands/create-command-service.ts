import type { ServerClient } from '../connection/server-client'
import type { LocalFilesPort } from '../settings/ports'
import { sleep } from '../connection/sleep'
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
  platform: NodeJS.Platform
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
  platform
}: Selection): CommandService | null {
  if (!api) return null
  if (!isPackaged && env.JARVIS_DEV_AUTH === '1') return null
  return new CommandService({
    api: new CommandApi(api),
    journal: new CommandJournal({ files, now: Date.now }),
    executor,
    platform,
    now: Date.now,
    clock: api.clock,
    sleep,
    // Fixed sentences only, so nothing about a command can reach the log.
    log: (message) => console.warn(`[commands] ${message}`)
  })
}
