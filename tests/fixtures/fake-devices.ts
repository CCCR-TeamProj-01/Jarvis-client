/**
 * The device and session part of the Jarvis server, following the real one as read from its code
 * and API spec (app/api/routes/devices.py, device_apps.py, auth.py) on 2026-10-23:
 *
 * - `GET /devices` lists the account's devices; `is_current` marks the device of the access token
 * - renaming trims the name and takes 1 to 100 characters; a device that is not the account's is a 404
 * - ending a device's sessions answers 204 and keeps the device registered; for the current device
 *   it ends the caller's own session too
 * - `GET /device/apps` lists only the current device's apps, a page at a time (limit 1 to 100)
 * - `PATCH /device/apps/{id}` changes `is_allowed` and/or `display_name`; null or unknown fields are a 422
 * - `POST /auth/logout-all` ends every session of the account
 */
export interface StoredDevice {
  device_id: number
  device_name: string
  platform: 'windows' | 'macos'
  client_version: string | null
  last_seen_at: number | null
}

export interface StoredApp {
  device_app_id: number
  app_code: string | null
  os_app_id: string | null
  display_name: string
  is_allowed: boolean
}

/** What a write is made to do on demand: fail with a status, or be carried out and then lose its answer. */
export type WriteFault = number | 'drop' | 'ok'

export class FakeDevices {
  /** The device the signed-in token belongs to. */
  readonly currentId = 12
  devices: StoredDevice[] = [
    {
      device_id: 12,
      device_name: '내 맥북',
      platform: 'macos',
      client_version: '0.1.0',
      last_seen_at: Date.now()
    },
    {
      device_id: 13,
      device_name: '집 데스크톱',
      platform: 'windows',
      client_version: '0.1.0',
      last_seen_at: Date.now() - 2 * 3600_000
    },
    {
      device_id: 14,
      device_name: '예전 노트북',
      platform: 'windows',
      client_version: null,
      last_seen_at: null
    }
  ]
  apps: StoredApp[] = [
    {
      device_app_id: 44,
      app_code: 'chrome',
      os_app_id: 'com.google.Chrome',
      display_name: 'Google Chrome',
      is_allowed: true
    },
    {
      device_app_id: 45,
      app_code: 'slack',
      os_app_id: 'com.tinyspeck.slackmacgap',
      display_name: 'Slack',
      is_allowed: false
    }
  ]
  readonly renames: { id: number; name: string }[] = []
  readonly deviceSignOuts: number[] = []
  logoutAlls = 0
  readonly appChanges: { id: number; body: Record<string, unknown> }[] = []
  /** Statuses for the next reads of the device list (consumed in order), or 'ok'. */
  readFaults: (number | 'ok')[] = []
  /** The same for the pages of apps. */
  appReadFaults: (number | 'ok')[] = []
  /** What happens to the next writes (consumed in order). */
  writeFaults: WriteFault[] = []

  list(naive: boolean) {
    const time = (ms: number | null) => {
      if (ms === null) return null
      const iso = new Date(ms).toISOString()
      return naive ? iso.replace('Z', '') : iso
    }
    return {
      items: this.devices.map((device) => ({
        device_id: device.device_id,
        device_name: device.device_name,
        platform: device.platform,
        client_version: device.client_version,
        last_seen_at: time(device.last_seen_at),
        is_current: device.device_id === this.currentId
      }))
    }
  }

  rename(id: number, body: Record<string, unknown> | null): { status: number; payload?: unknown } {
    const device = this.devices.find((candidate) => candidate.device_id === id)
    if (!device) return { status: 404, payload: this.error('DEVICE_NOT_FOUND') }
    const name = typeof body?.device_name === 'string' ? body.device_name.trim() : ''
    const extra = Object.keys(body ?? {}).some((key) => key !== 'device_name')
    if (extra || Array.from(name).length < 1 || Array.from(name).length > 100)
      return { status: 422, payload: this.error('VALIDATION_ERROR') }
    device.device_name = name
    this.renames.push({ id, name })
    return {
      status: 200,
      payload: { device_id: id, device_name: name, platform: device.platform }
    }
  }

  signOutDevice(id: number): { status: number; payload?: unknown } {
    if (!this.devices.some((candidate) => candidate.device_id === id))
      return { status: 404, payload: this.error('DEVICE_NOT_FOUND') }
    this.deviceSignOuts.push(id)
    return { status: 204 }
  }

  /** A page of the current device's apps. The cursor is the ID the page starts after. */
  listApps(query: URLSearchParams): { status: number; payload: unknown } {
    const limitText = query.get('limit')
    const limit = limitText === null ? 20 : Number(limitText)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return { status: 422, payload: this.error('VALIDATION_ERROR') }
    const cursor = query.get('cursor')
    const after = cursor === null ? 0 : Number(cursor.replace(/^c/, ''))
    if (cursor !== null && (!/^c\d+$/.test(cursor) || !Number.isSafeInteger(after)))
      return { status: 422, payload: this.error('VALIDATION_ERROR') }
    const rest = [...this.apps]
      .sort((left, right) => left.device_app_id - right.device_app_id)
      .filter((app) => app.device_app_id > after)
    const page = rest.slice(0, limit)
    const more = rest.length > page.length
    return {
      status: 200,
      payload: {
        items: page,
        next_cursor: more ? `c${page[page.length - 1]!.device_app_id}` : null,
        has_more: more
      }
    }
  }

  changeApp(
    id: number,
    body: Record<string, unknown> | null
  ): { status: number; payload: unknown } {
    const app = this.apps.find((candidate) => candidate.device_app_id === id)
    if (!app) return { status: 404, payload: this.error('NOT_FOUND') }
    const fields = Object.keys(body ?? {})
    const unknown = fields.some((key) => key !== 'is_allowed' && key !== 'display_name')
    const nulls = fields.some((key) => body?.[key] === null)
    const badAllowed = 'is_allowed' in (body ?? {}) && typeof body?.is_allowed !== 'boolean'
    if (unknown || nulls || badAllowed || fields.length === 0)
      return { status: 422, payload: this.error('VALIDATION_ERROR') }
    if (typeof body?.is_allowed === 'boolean') app.is_allowed = body.is_allowed
    this.appChanges.push({ id, body: body ?? {} })
    return {
      status: 200,
      payload: {
        device_app_id: id,
        app_code: app.app_code,
        display_name: app.display_name,
        is_allowed: app.is_allowed
      }
    }
  }

  private error(code: string) {
    return { error: { code, message: 'x', request_id: 'req_x', details: {} } }
  }
}
