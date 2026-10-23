import { z } from 'zod'
import type { ClientError, Result } from '../../shared/contracts/common'
import type { ServerClient } from '../connection/server-client'
import type { CollectionConsent } from './activity'

export interface CollectionConsentPort {
  /** The user's current consent to collect activity, as the server holds it. */
  read(signal?: AbortSignal): Promise<Result<CollectionConsent>>
}

/** The flags a change may name; a flag left out is not touched. */
export interface CollectionChange {
  activity?: boolean
  external?: boolean
}

/**
 * What came of a change. `rejected`: the server refused or the request never left, so nothing
 * changed. `unknown`: no answer, an answer that cannot be read, or a server error; the change may
 * have been made.
 */
export type CollectionChanged =
  | { kind: 'done'; value: CollectionConsent }
  | { kind: 'rejected'; error: ClientError }
  | { kind: 'unknown'; error: ClientError }

export interface CollectionSettingsApiPort extends CollectionConsentPort {
  change(change: CollectionChange, signal?: AbortSignal): Promise<CollectionChanged>
}

const SettingsSchema = z.looseObject({
  activity_collection_enabled: z.boolean(),
  external_activity_collection_enabled: z.boolean(),
  collection_revision: z.number().int().nonnegative()
})

/** Short, so a slow server delays a command's result by little: without an answer, nothing is collected. */
const READ_TIMEOUT_MS = 3_000

const toConsent = (settings: z.infer<typeof SettingsSchema>): CollectionConsent => ({
  activityEnabled: settings.activity_collection_enabled,
  externalEnabled: settings.external_activity_collection_enabled,
  revision: settings.collection_revision
})

/** The collection settings over REST (`GET` and `PATCH /me/settings`). */
export class CollectionConsentApi implements CollectionSettingsApiPort {
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
    return { ok: true, value: toConsent(response.value) }
  }

  /**
   * Sends one change, once, with only the flags named. Setting a flag to the value it has is no
   * change at the server, so a repeat does no harm; it is still not sent again here.
   */
  async change(change: CollectionChange, signal?: AbortSignal): Promise<CollectionChanged> {
    const body = {
      ...(change.activity === undefined ? {} : { activity_collection_enabled: change.activity }),
      ...(change.external === undefined
        ? {}
        : { external_activity_collection_enabled: change.external })
    }
    const response = await this.client.request({
      method: 'PATCH',
      path: '/me/settings',
      body,
      response: SettingsSchema,
      ...(signal ? { signal } : {})
    })
    if (response.ok) return { kind: 'done', value: toConsent(response.value) }
    const { detail } = response
    // Not sent, or refused with a 4xx: nothing was changed.
    if (detail.delivery === 'not_sent') return { kind: 'rejected', error: response.error }
    const status = detail.status
    if (detail.delivery === 'responded' && status !== undefined && status >= 400 && status < 500)
      return { kind: 'rejected', error: response.error }
    return { kind: 'unknown', error: response.error }
  }
}
