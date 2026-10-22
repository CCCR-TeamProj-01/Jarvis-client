import type { Unsubscribe } from '../../shared/contracts/common'
import type { AuthManager } from '../auth/auth-manager'
import type { ServerClient } from '../connection/server-client'
import type { LocalFilesPort } from '../settings/ports'
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

/** Waits `ms`, or less when the signal aborts. The timer never keeps the app alive. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    timer.unref()
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
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

/**
 * Receives commands while a user is signed in. Signing out, or the session ending, stops it and
 * cancels what is running; another account signing in starts it for that account.
 */
export function runWhileSignedIn(
  auth: Pick<AuthManager, 'getSnapshot' | 'subscribe'>,
  service: Pick<CommandService, 'start' | 'stop'>
): Unsubscribe {
  const apply = (snapshot: ReturnType<AuthManager['getSnapshot']>) => {
    if (snapshot.phase === 'signed_in') service.start(snapshot.user.userId)
    else void service.stop()
  }
  apply(auth.getSnapshot())
  const unsubscribe = auth.subscribe((event) => {
    if (event.type === 'auth.state_changed') apply(event.snapshot)
  })
  return () => {
    unsubscribe()
    void service.stop()
  }
}
