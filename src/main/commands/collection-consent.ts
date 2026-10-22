import { z } from 'zod'
import type { Result } from '../../shared/contracts/common'
import type { ServerClient } from '../connection/server-client'
import type { CollectionConsent } from './activity'

export interface CollectionConsentPort {
  /** The user's current consent to collect activity, as the server holds it. */
  read(signal?: AbortSignal): Promise<Result<CollectionConsent>>
}

const SettingsSchema = z.looseObject({
  activity_collection_enabled: z.boolean(),
  external_activity_collection_enabled: z.boolean(),
  collection_revision: z.number().int().nonnegative()
})

/** Short, so a slow server delays a command's result by little: without an answer, nothing is collected. */
const READ_TIMEOUT_MS = 3_000

/** The collection settings over REST (`GET /me/settings`). */
export class CollectionConsentApi implements CollectionConsentPort {
  constructor(private readonly client: ServerClient) {}

  async read(signal?: AbortSignal): Promise<Result<CollectionConsent>> {
    const response = await this.client.request({
      method: 'GET',
      path: '/me/settings',
      response: SettingsSchema,
      timeoutMs: READ_TIMEOUT_MS,
      ...(signal ? { signal } : {})
    })
    if (!response.ok) return { ok: false, error: response.error }
    return {
      ok: true,
      value: {
        activityEnabled: response.value.activity_collection_enabled,
        externalEnabled: response.value.external_activity_collection_enabled,
        revision: response.value.collection_revision
      }
    }
  }
}
