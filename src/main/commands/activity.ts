import type { ToolName } from '../../shared/contracts/tools'
import { appCodeFor } from '../platform/app-codes'
import type { AppCode } from '../platform/app-codes'
import type { ActivityReport, CommandResult } from './command-result'

/** What the user allowed, as the server holds it. */
export interface CollectionConsent {
  /** Activity from commands this app ran may be recorded. */
  activityEnabled: boolean
  /** What else is running on the computer may be looked at. */
  externalEnabled: boolean
  /** Changes whenever the settings do; the server records nothing for an old one. */
  revision: number
}

/** The tools whose result can say an app was used. */
const APP_TOOLS: ReadonlySet<ToolName> = new Set(['apps.launch', 'apps.activate', 'apps.restore'])

export const usesApp = (tool: ToolName): boolean => APP_TOOLS.has(tool)

/**
 * Whether the app was newly started or only brought to the front. Starting an app that was
 * already running is not a new start, so launching is a start only when the app was seen not to be
 * running beforehand; when that is not known, nothing is claimed (`null`).
 */
export function eventTypeFor(
  tool: ToolName,
  osAppId: string,
  runningBefore: ReadonlySet<string> | null
): 'launched' | 'activated' | null {
  if (tool === 'apps.activate' || tool === 'apps.restore') return 'activated'
  if (tool !== 'apps.launch' || runningBefore === null) return null
  return runningBefore.has(osAppId) ? 'activated' : 'launched'
}

/** The server's codes of the apps that are running, each once, in a fixed order. */
export function runningAppCodes(
  runningOsAppIds: readonly string[],
  platform: NodeJS.Platform
): AppCode[] {
  const codes = new Set<AppCode>()
  for (const id of runningOsAppIds) {
    const code = appCodeFor(id, platform)
    if (code) codes.add(code)
  }
  return [...codes].sort()
}

export interface ActivityInput {
  tool: ToolName
  result: CommandResult
  consent: CollectionConsent
  /** OS app IDs running before the command; null when it was not taken or could not be. */
  runningBefore: ReadonlySet<string> | null
  /** The server's codes of the apps running now; null when not taken, not allowed, or unknown. */
  runningNow: readonly AppCode[] | null
  eventKey: string
}

/**
 * What kind of activity a finished command calls for, or nothing. It is made only for what was
 * seen to happen: a successful, confirmed use of an app the server knows, with the user's consent.
 * A request that was only handed over (`dispatched`), a failure and a result that could not be
 * told are never turned into one.
 */
export function activityEventType(
  input: Pick<ActivityInput, 'tool' | 'result' | 'consent' | 'runningBefore'>
): 'launched' | 'activated' | null {
  const { result, consent } = input
  if (!consent.activityEnabled || !usesApp(input.tool)) return null
  if (result.status !== 'success' || result.observation_status !== 'confirmed') return null
  if (!result.app) return null
  return eventTypeFor(input.tool, result.app.os_app_id, input.runningBefore)
}

/** The activity to report for a finished command, or nothing (see `activityEventType`). */
export function activityFor(input: ActivityInput): ActivityReport | undefined {
  const eventType = activityEventType(input)
  if (eventType === null) return undefined
  return {
    event_key: input.eventKey,
    event_type: eventType,
    occurred_at: input.result.finished_at,
    collection_revision: input.consent.revision,
    // The list is only ever taken with the extra consent; without it nothing is sent.
    ...(input.consent.externalEnabled && input.runningNow !== null
      ? { running_apps: [...input.runningNow] }
      : {})
  }
}

/**
 * The result as it is sent now. The activity was made when the command finished; the settings may
 * have changed since, so it is checked again: with no consent, or for an old revision, it is left
 * out (the result itself is still sent); without the extra consent only the list of apps is.
 */
export function resultForSending(
  result: CommandResult,
  consent: CollectionConsent | null
): CommandResult {
  const { activity, ...rest } = result
  if (!activity) return result
  if (!consent || !consent.activityEnabled || consent.revision !== activity.collection_revision)
    return rest
  if (consent.externalEnabled || activity.running_apps === undefined) return result
  const { running_apps: _dropped, ...withoutList } = activity
  return { ...rest, activity: withoutList }
}
