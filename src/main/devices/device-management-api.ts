import { z } from 'zod'
import type { ClientError, Result } from '../../shared/contracts/common'
import type { DevicePlatform } from '../../shared/contracts/devices'
import type { ServerClient } from '../connection/server-client'
import { EmptyResponse } from '../connection/server-client'
import { ServerIdSchema } from '../connection/server-ids'
import { ServerTimeSchema } from '../connection/server-time'

/** A device of the account as the server holds it. Times are the server's own clock, in milliseconds. */
export interface ServerDevice {
  id: string
  name: string
  platform: DevicePlatform
  clientVersion: string | null
  lastSeenAtMs: number | null
  /** The device the request was made from, by the access token. */
  current: boolean
}

/** An app seen on this device. */
export interface ServerApp {
  id: string
  appCode: string | null
  name: string
  allowed: boolean
}

export interface AppPage {
  items: ServerApp[]
  /** Where the next page starts, or null when there is none to read. */
  next: string | null
  /** The server says more apps exist after this page. */
  more: boolean
}

/**
 * What came of a change. `rejected`: the server refused, so nothing changed. `unknown`: no answer,
 * an answer that cannot be read, or a server error; the change may have been made.
 */
export type Change<T> =
  | { kind: 'done'; value: T }
  | { kind: 'not_found' }
  | { kind: 'rejected'; error: ClientError }
  | { kind: 'unknown'; error: ClientError }

export interface DeviceManagementApiPort {
  devices(signal?: AbortSignal): Promise<Result<ServerDevice[]>>
  rename(deviceId: string, name: string, signal?: AbortSignal): Promise<Change<{ name: string }>>
  /** Ends every session of one device; its registration stays. */
  signOutDevice(deviceId: string, signal?: AbortSignal): Promise<Change<void>>
  /** Ends every session of the account, this one included. */
  signOutAll(signal?: AbortSignal): Promise<Change<void>>
  apps(cursor: string | null, signal?: AbortSignal): Promise<Result<AppPage>>
  setAppAllowed(
    appId: string,
    allowed: boolean,
    signal?: AbortSignal
  ): Promise<Change<{ allowed: boolean }>>
}

const DeviceSchema = z.looseObject({
  device_id: ServerIdSchema,
  device_name: z.string().min(1),
  platform: z.string(),
  client_version: z.string().min(1).nullish(),
  last_seen_at: ServerTimeSchema.nullish(),
  is_current: z.boolean()
})
const DeviceListSchema = z.looseObject({ items: z.array(DeviceSchema) })
const RenamedSchema = z.looseObject({ device_name: z.string().min(1) })

const AppSchema = z.looseObject({
  device_app_id: ServerIdSchema,
  app_code: z.string().min(1).nullish(),
  display_name: z.string().min(1),
  is_allowed: z.boolean()
})
const AppListSchema = z.looseObject({
  items: z.array(AppSchema),
  next_cursor: z.string().min(1).max(256).nullish(),
  has_more: z.boolean().optional()
})
const AppChangedSchema = z.looseObject({ is_allowed: z.boolean() })

/** An ID from an earlier answer, checked once more before it joins a path. */
const ID = /^\d{1,16}$/
const PAGE_SIZE = 100
const gone = { kind: 'not_found' } as const

const platformOf = (value: string): DevicePlatform =>
  value === 'windows' || value === 'macos' ? value : 'other'

/** The account's devices and this device's apps over REST (`/devices`, `/device/apps`, `/auth/logout-all`). */
export class DeviceManagementApi implements DeviceManagementApiPort {
  constructor(private readonly client: ServerClient) {}

  async devices(signal?: AbortSignal): Promise<Result<ServerDevice[]>> {
    const response = await this.client.request({
      method: 'GET',
      path: '/devices',
      response: DeviceListSchema,
      ...(signal ? { signal } : {})
    })
    if (!response.ok) return { ok: false, error: response.error }
    return {
      ok: true,
      value: response.value.items.map((item) => ({
        id: item.device_id,
        name: item.device_name,
        platform: platformOf(item.platform),
        clientVersion: item.client_version ?? null,
        lastSeenAtMs: item.last_seen_at ? Date.parse(item.last_seen_at) : null,
        current: item.is_current
      }))
    }
  }

  rename(deviceId: string, name: string, signal?: AbortSignal): Promise<Change<{ name: string }>> {
    if (!ID.test(deviceId)) return Promise.resolve(gone)
    return this.change(
      'PATCH',
      `/devices/${deviceId}`,
      { device_name: name },
      RenamedSchema,
      (value) => ({ name: value.device_name }),
      signal
    )
  }

  signOutDevice(deviceId: string, signal?: AbortSignal): Promise<Change<void>> {
    if (!ID.test(deviceId)) return Promise.resolve(gone)
    return this.change(
      'DELETE',
      `/devices/${deviceId}/sessions`,
      undefined,
      EmptyResponse,
      () => undefined,
      signal
    )
  }

  signOutAll(signal?: AbortSignal): Promise<Change<void>> {
    return this.change(
      'POST',
      '/auth/logout-all',
      undefined,
      EmptyResponse,
      () => undefined,
      signal
    )
  }

  async apps(cursor: string | null, signal?: AbortSignal): Promise<Result<AppPage>> {
    const response = await this.client.request({
      method: 'GET',
      path: '/device/apps',
      query: { limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) },
      response: AppListSchema,
      ...(signal ? { signal } : {})
    })
    if (!response.ok) return { ok: false, error: response.error }
    const { items, next_cursor: following, has_more: hasMore } = response.value
    const more = hasMore ?? (following !== null && following !== undefined)
    return {
      ok: true,
      value: {
        items: items.map((item) => ({
          id: item.device_app_id,
          appCode: item.app_code ?? null,
          name: item.display_name,
          allowed: item.is_allowed
        })),
        // A page that says there is more but names no place to continue from cannot be followed.
        next: more ? (following ?? null) : null,
        more
      }
    }
  }

  setAppAllowed(
    appId: string,
    allowed: boolean,
    signal?: AbortSignal
  ): Promise<Change<{ allowed: boolean }>> {
    if (!ID.test(appId)) return Promise.resolve(gone)
    return this.change(
      'PATCH',
      `/device/apps/${appId}`,
      { is_allowed: allowed },
      AppChangedSchema,
      (value) => ({ allowed: value.is_allowed }),
      signal
    )
  }

  /**
   * Sends one change, once; none of these is retried. A refusal (4xx) changed nothing; no answer,
   * an answer that cannot be read, or a server error leaves it open whether the change was made.
   */
  private async change<Body, Out>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    schema: z.ZodType<Body>,
    out: (value: Body) => Out,
    signal?: AbortSignal
  ): Promise<Change<Out>> {
    const result = await this.client.request({
      method,
      path,
      ...(body === undefined ? {} : { body }),
      response: schema,
      ...(signal ? { signal } : {})
    })
    if (result.ok) return { kind: 'done', value: out(result.value) }
    const { detail } = result
    // Not sent: nothing reached the server, so nothing was changed.
    if (detail.delivery === 'not_sent') return { kind: 'rejected', error: result.error }
    const status = detail.status
    if (detail.delivery === 'responded' && status !== undefined && status >= 400 && status < 500)
      return status === 404 ? gone : { kind: 'rejected', error: result.error }
    return { kind: 'unknown', error: result.error }
  }
}
