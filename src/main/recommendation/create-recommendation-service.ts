import type { RecommendationCard } from '../../shared/contracts/recommendation'
import type { ServerClient } from '../connection/server-client'
import { sleep } from '../sleep'
import { RecommendationApi } from './recommendation-api'
import { RecommendationService } from './recommendation-service'
import type { RecommendationServiceOptions } from './recommendation-service'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The client for server calls; null when there is no usable server. */
  api: ServerClient | null
  canShow(): boolean
  /** The running apps, to leave out what is already open. Left out: nothing is filtered. */
  alreadyOpen?: RecommendationServiceOptions['alreadyOpen']
  publish(card: RecommendationCard | null): void
}

/**
 * Exists only with a real server and a real login. The development sign-in stand-in
 * (JARVIS_DEV_AUTH=1) has no session the server would accept, so asking with it would only fail.
 */
export function createRecommendationService({
  isPackaged,
  env,
  api,
  canShow,
  alreadyOpen,
  publish
}: Selection): RecommendationService | null {
  if (!api) return null
  if (!isPackaged && env.JARVIS_DEV_AUTH === '1') return null
  return new RecommendationService({
    api: new RecommendationApi(api),
    now: Date.now,
    clock: api.clock,
    sleep,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      timer.unref()
      return () => clearTimeout(timer)
    },
    canShow,
    ...(alreadyOpen ? { alreadyOpen } : {}),
    publish,
    // Fixed sentences only, so nothing a recommendation says can reach the log.
    log: (message) => console.warn(`[recommendation] ${message}`)
  })
}
