import { CollectionConsentApi } from '../commands/collection-consent'
import type { CollectionConsentPort } from '../commands/collection-consent'
import type { ServerClient } from '../connection/server-client'
import {
  CollectionSettingsService,
  UnavailableCollectionSettings
} from './collection-settings-service'

interface Selection {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The client for server calls; null when there is no usable server. */
  api: ServerClient | null
  /** What is collected may now differ: whoever holds a consent read earlier must read it again. */
  onChanged(): void
}

/**
 * Exists only with a real server and a real login. The development sign-in stand-in
 * (JARVIS_DEV_AUTH=1) has no session the server would accept, so the tab says it is unavailable and
 * the commands have no consent to go by.
 */
export function createCollectionSettings({ isPackaged, env, api, onChanged }: Selection): {
  service: CollectionSettingsService | null
  collection: CollectionSettingsService | UnavailableCollectionSettings
  /** What the commands read the consent through: the service, which applies a withdrawal at once. */
  consent: CollectionConsentPort | null
} {
  if (!api || (!isPackaged && env.JARVIS_DEV_AUTH === '1'))
    return { service: null, collection: new UnavailableCollectionSettings(), consent: null }
  const service = new CollectionSettingsService({
    api: new CollectionConsentApi(api),
    now: Date.now,
    onChanged
  })
  return { service, collection: service, consent: service }
}
