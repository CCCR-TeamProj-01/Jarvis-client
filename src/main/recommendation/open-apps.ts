import type { RecommendationTarget } from '../../shared/contracts/recommendation'
import { isAppCode, osAppIdFor } from '../commands/app-codes'
import type { AppControlPort } from '../platform/ports'

/**
 * Whether every app a recommendation suggests is already running on this machine, in which case
 * there is nothing to suggest. When it cannot be told (an app with no known code, a platform with
 * no mapping, the app list unavailable), the answer is no and the recommendation is shown: a
 * suggestion that was not needed costs little, a missing one costs the feature.
 */
export function createOpenAppsCheck(
  appControl: Pick<AppControlPort, 'list'>,
  platform: NodeJS.Platform
): (targets: readonly RecommendationTarget[]) => Promise<boolean> {
  return async (targets) => {
    const wanted: string[] = []
    for (const target of targets) {
      const osAppId =
        target.appCode !== null && isAppCode(target.appCode)
          ? osAppIdFor(target.appCode, platform)
          : undefined
      if (osAppId === undefined) return false
      wanted.push(osAppId)
    }
    if (wanted.length === 0) return false
    const apps = await appControl.list()
    if (!apps.ok) return false
    const running = new Set(
      apps.value.filter((app) => app.state === 'running').map((app) => app.appId)
    )
    return wanted.every((appId) => running.has(appId))
  }
}
