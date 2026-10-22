import { z } from 'zod'
import type { ClientError, Result } from '../../shared/contracts/common'
import type { ServerClient } from '../connection/server-client'
import { EmptyResponse } from '../connection/server-client'
import { ServerIdSchema } from '../connection/server-ids'
import { ServerTimeSchema } from '../connection/server-time'

/** The Google connection as the server holds it. Times are the server's own clock, in milliseconds. */
export interface ServerConnection {
  id: string
  status: 'active' | 'reconnect_required'
  connectedAtMs: number
  lastSyncedAtMs: number | null
}

export interface Authorization {
  /** Where the user gives consent. Not yet checked: the service decides whether it may be opened. */
  url: string
  expiresAtServerMs: number
}

/** What the server said to a request to import. */
export type SyncStart =
  | { kind: 'queued' }
  /** The server holds a connection it can no longer use. */
  | { kind: 'reconnect_required' }
  | { kind: 'not_found' }
  | { kind: 'failed'; error: ClientError }

export type Disconnected =
  | { kind: 'done' }
  /** There was nothing to disconnect; the same end as done. */
  | { kind: 'not_found' }
  | { kind: 'failed'; error: ClientError }

export interface GoogleConnectionApiPort {
  /** The user's Google connection, or null when there is none. */
  connection(signal?: AbortSignal): Promise<Result<ServerConnection | null>>
  authorize(signal?: AbortSignal): Promise<Result<Authorization>>
  sync(connectionId: string, signal?: AbortSignal): Promise<SyncStart>
  disconnect(connectionId: string, signal?: AbortSignal): Promise<Disconnected>
}

const ConnectionSchema = z.looseObject({
  connection_id: ServerIdSchema,
  provider: z.string(),
  status: z.string(),
  connected_at: ServerTimeSchema,
  last_synced_at: ServerTimeSchema.nullish()
})
const ListSchema = z.looseObject({ items: z.array(ConnectionSchema) })
const AuthorizationSchema = z.looseObject({
  authorization_url: z.string().min(1).max(4096),
  expires_at: ServerTimeSchema
})
const AcceptedSchema = z.looseObject({})

const ID = /^\d{1,16}$/
const gone = { kind: 'not_found' } as const

/** The Google Calendar connection over REST (`/calendar/connections`). */
export class GoogleConnectionApi implements GoogleConnectionApiPort {
  constructor(private readonly client: ServerClient) {}

  async connection(signal?: AbortSignal): Promise<Result<ServerConnection | null>> {
    const response = await this.client.request({
      method: 'GET',
      path: '/calendar/connections',
      response: ListSchema,
      ...(signal ? { signal } : {})
    })
    if (!response.ok) return { ok: false, error: response.error }
    const found = response.value.items.find((item) => item.provider === 'google')
    if (!found) return { ok: true, value: null }
    return {
      ok: true,
      value: {
        id: found.connection_id,
        // Anything but `active` is a connection that has to be made again.
        status: found.status === 'active' ? 'active' : 'reconnect_required',
        connectedAtMs: Date.parse(found.connected_at),
        lastSyncedAtMs: found.last_synced_at ? Date.parse(found.last_synced_at) : null
      }
    }
  }

  async authorize(signal?: AbortSignal): Promise<Result<Authorization>> {
    const response = await this.client.request({
      method: 'POST',
      path: '/calendar/connections/google/authorizations',
      response: AuthorizationSchema,
      ...(signal ? { signal } : {})
    })
    if (!response.ok) return { ok: false, error: response.error }
    return {
      ok: true,
      value: {
        url: response.value.authorization_url,
        expiresAtServerMs: Date.parse(response.value.expires_at)
      }
    }
  }

  async sync(connectionId: string, signal?: AbortSignal): Promise<SyncStart> {
    if (!ID.test(connectionId)) return gone
    const response = await this.client.request({
      method: 'POST',
      path: `/calendar/connections/${connectionId}/syncs`,
      response: AcceptedSchema,
      ...(signal ? { signal } : {})
    })
    if (response.ok) return { kind: 'queued' }
    if (response.detail.delivery === 'responded') {
      if (response.detail.status === 404) return gone
      if (
        response.detail.status === 409 &&
        response.detail.serverCode === 'CALENDAR_RECONNECT_REQUIRED'
      )
        return { kind: 'reconnect_required' }
    }
    return { kind: 'failed', error: response.error }
  }

  async disconnect(connectionId: string, signal?: AbortSignal): Promise<Disconnected> {
    if (!ID.test(connectionId)) return gone
    const response = await this.client.request({
      method: 'DELETE',
      path: `/calendar/connections/${connectionId}`,
      response: z.union([EmptyResponse, AcceptedSchema]),
      ...(signal ? { signal } : {})
    })
    if (response.ok) return { kind: 'done' }
    if (response.detail.delivery === 'responded' && response.detail.status === 404) return gone
    return { kind: 'failed', error: response.error }
  }
}
