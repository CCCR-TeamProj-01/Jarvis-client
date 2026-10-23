import { afterEach, describe, expect, it } from 'vitest'
import { runWhileSignedIn } from '../../src/main/auth/run-while-signed-in'
import { DeviceManagementApi } from '../../src/main/devices/device-management-api'
import { DeviceManagementService } from '../../src/main/devices/device-management-service'
import { FakeDevices } from '../fixtures/fake-devices'
import type { StoredApp } from '../fixtures/fake-devices'
import { stopAllFakeServers } from '../fixtures/fake-jarvis-server'
import { signedInApp } from '../fixtures/signed-in-app'
import { waitUntil } from '../helpers/wait'

const stops: (() => void)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  await stopAllFakeServers()
})

/** The real client stack over HTTP, wired as the app wires it: signing out everywhere ends the local session too. */
async function devicesApp(options: { naiveTimes?: boolean; maxAppPages?: number } = {}) {
  const app = await signedInApp()
  app.fake.naiveTimes = options.naiveTimes ?? true
  const devices = new FakeDevices()
  app.fake.devices = devices
  const service = new DeviceManagementService({
    api: new DeviceManagementApi(app.api),
    now: Date.now,
    clock: app.api.clock,
    endLocalSession: () => app.manager.signOut(),
    ...(options.maxAppPages === undefined ? {} : { maxAppPages: options.maxAppPages })
  })
  stops.push(runWhileSignedIn(app.manager, service))
  const run = async (request: Parameters<DeviceManagementService['command']>[0]) => {
    const result = await service.command(request)
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  }
  const requests = (method: string, prefix: string) =>
    app.fake.calls.filter((call) => call.method === method && call.path.startsWith(prefix)).length
  return { ...app, devices, service, run, requests }
}

const manyApps = (count: number): StoredApp[] =>
  Array.from({ length: count }, (_, index) => ({
    device_app_id: 100 + index,
    app_code: null,
    os_app_id: null,
    display_name: `앱 ${index}`,
    is_allowed: true
  }))

describe('the account’s devices over HTTP', () => {
  it('lists the devices and the apps, with times read in UTC however the server writes them', async () => {
    for (const naiveTimes of [true, false]) {
      const t = await devicesApp({ naiveTimes })
      const state = await t.run({ action: 'refresh' })
      expect(
        state.devices.items.map((item) => [item.id, item.name, item.platform, item.current])
      ).toEqual([
        ['12', '내 맥북', 'macos', true],
        ['13', '집 데스크톱', 'windows', false],
        ['14', '예전 노트북', 'windows', false]
      ])
      expect(state.devices.items[0]).toMatchObject({ clientVersion: '0.1.0', online: true })
      // Seen two hours ago: not online, and the time is the real one, not shifted by the local zone.
      const seen = state.devices.items[1]!
      expect(seen.online).toBe(false)
      expect(Math.abs(Date.now() - 2 * 3600_000 - seen.lastSeenAt!)).toBeLessThan(10_000)
      expect(state.devices.items[2]).toMatchObject({ clientVersion: null, lastSeenAt: null })
      expect(state.apps.items).toEqual([
        { id: '44', appCode: 'chrome', name: 'Google Chrome', allowed: true },
        { id: '45', appCode: 'slack', name: 'Slack', allowed: false }
      ])
      await stopAllFakeServers()
    }
  })

  it('renames a device with the trimmed name, and the list shows what the server holds', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    const state = await t.run({ action: 'rename_device', deviceId: '13', name: '  작업실 PC ' })
    expect(t.devices.renames).toEqual([{ id: 13, name: '작업실 PC' }])
    expect(state.devices.items.find((item) => item.id === '13')?.name).toBe('작업실 PC')
    expect(state.outcome).toMatchObject({ kind: 'renamed' })
    // Reading again gives the same.
    expect(
      (await t.run({ action: 'refresh' })).devices.items.find((item) => item.id === '13')?.name
    ).toBe('작업실 PC')
  })

  it('shows a refusal from the server as a failure and leaves the name', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    // Too long: the window never sends it, but the server is the one that decides.
    const state = await t.run({ action: 'rename_device', deviceId: '13', name: 'x'.repeat(101) })
    expect(state.outcome).toMatchObject({ kind: 'failed', subject: 'device' })
    expect(state.devices.items.find((item) => item.id === '13')?.name).toBe('집 데스크톱')
    expect(t.devices.renames).toEqual([])
  })

  it('learns a device was removed from the server’s own 404 and reads the list again', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    t.devices.devices = t.devices.devices.filter((device) => device.device_id !== 13)
    const state = await t.run({ action: 'rename_device', deviceId: '13', name: '새 이름' })
    expect(state.outcome).toMatchObject({ kind: 'device_gone' })
    expect(state.devices.items.map((item) => item.id)).toEqual(['12', '14'])
  })

  it('ends the sessions of another device and keeps the device registered', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    const state = await t.run({ action: 'sign_out_device', deviceId: '13' })
    expect(t.devices.deviceSignOuts).toEqual([13])
    expect(state.outcome).toMatchObject({ kind: 'device_signed_out' })
    expect(state.devices.items.map((item) => item.id)).toContain('13')
    // This computer is still signed in.
    expect(t.manager.getSnapshot().phase).toBe('signed_in')
    expect((await t.ping()).ok).toBe(true)
  })

  it('does not ask the server to end this device’s sessions from the list', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    const state = await t.run({ action: 'sign_out_device', deviceId: '12' })
    expect(t.requests('DELETE', '/devices')).toBe(0)
    expect(state.outcome).toMatchObject({ kind: 'failed' })
    expect(t.manager.getSnapshot().phase).toBe('signed_in')
  })

  it('tells a lost answer from a failure, reads again, and never sends the change twice', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    // The server carries it out, and the answer is lost on the way.
    t.devices.writeFaults = ['drop']
    const lost = await t.run({ action: 'rename_device', deviceId: '13', name: '작업실 PC' })
    expect(lost.outcome).toMatchObject({ kind: 'unconfirmed' })
    expect(t.requests('PATCH', '/devices/13')).toBe(1)
    // The list was read again, so it shows what really happened.
    expect(lost.devices.items.find((item) => item.id === '13')?.name).toBe('작업실 PC')

    // A server error: it is not known whether it was done either.
    t.devices.writeFaults = [503]
    const error = await t.run({ action: 'sign_out_device', deviceId: '14' })
    expect(error.outcome).toMatchObject({ kind: 'unconfirmed' })
    expect(t.requests('DELETE', '/devices/14/sessions')).toBe(1)
  })

  it('shows a read failure as an error and keeps the earlier list', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    t.devices.readFaults = [503]
    const state = await t.run({ action: 'refresh' })
    expect(state.devices).toMatchObject({ read: 'failed' })
    expect(state.devices.error).not.toBeNull()
    expect(state.devices.items).toHaveLength(3)
    expect(state.apps.read).toBe('ready')
  })
})

describe('signing out everywhere over HTTP', () => {
  it('ends every session at the server, then this computer’s own', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    await t.run({ action: 'sign_out_all' })
    expect(t.devices.logoutAlls).toBe(1)
    await waitUntil(() => t.manager.getSnapshot().phase === 'signed_out')
    // The window must not keep the account's devices.
    expect(t.service.getSnapshot()).toMatchObject({
      devices: { read: 'idle', items: [] },
      apps: { read: 'idle', items: [] },
      outcome: null
    })
    // And the saved login is gone, so the next start asks for a password.
    expect(await t.store.load()).toEqual({ ok: true, value: null })
  })

  it('keeps this computer signed in when the server fails', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    t.devices.writeFaults = [503]
    const state = await t.run({ action: 'sign_out_all' })
    // A server error says nothing about whether it ended the sessions.
    expect(state.outcome).toMatchObject({ kind: 'unconfirmed', subject: 'account' })
    expect(t.manager.getSnapshot().phase).toBe('signed_in')
    expect(t.devices.logoutAlls).toBe(0)
    expect(t.requests('POST', '/auth/logout-all')).toBe(1)
    expect(state.devices.items).toHaveLength(3)
  })

  it('does not sign out on a lost answer, and the session ends by itself once the server refuses it', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    t.devices.writeFaults = ['drop']
    const state = await t.run({ action: 'sign_out_all' })
    expect(state.outcome).toMatchObject({ kind: 'unconfirmed', subject: 'account' })
    expect(t.requests('POST', '/auth/logout-all')).toBe(1)
    // The server did end every session. This computer finds out on its next request.
    expect(t.manager.getSnapshot().phase).toBe('signed_in')
    expect((await t.ping()).ok).toBe(false)
    await waitUntil(() => t.manager.getSnapshot().phase === 'signed_out')
  })
})

describe('the apps of this device over HTTP', () => {
  it('blocks and allows an app with only the field that changed', async () => {
    const t = await devicesApp()
    await t.run({ action: 'refresh' })
    const blocked = await t.run({ action: 'set_app_allowed', appId: '44', allowed: false })
    expect(t.devices.appChanges).toEqual([{ id: 44, body: { is_allowed: false } }])
    expect(blocked.apps.items.find((item) => item.id === '44')?.allowed).toBe(false)
    expect(blocked.outcome).toMatchObject({ kind: 'app_blocked' })
    const allowed = await t.run({ action: 'set_app_allowed', appId: '44', allowed: true })
    expect(allowed.apps.items.find((item) => item.id === '44')?.allowed).toBe(true)
    expect(t.devices.appChanges.at(-1)).toEqual({ id: 44, body: { is_allowed: true } })
  })

  it('reads every page of a long list', async () => {
    const t = await devicesApp()
    t.devices.apps = manyApps(230)
    const state = await t.run({ action: 'refresh' })
    expect(state.apps.items).toHaveLength(230)
    expect(state.apps.truncated).toBe(false)
    expect(t.requests('GET', '/device/apps')).toBe(3)
  })

  it('stops at the page limit and says the list is not whole', async () => {
    const t = await devicesApp({ maxAppPages: 2 })
    t.devices.apps = manyApps(230)
    const state = await t.run({ action: 'refresh' })
    expect(state.apps.items).toHaveLength(200)
    expect(state.apps.truncated).toBe(true)
  })

  it('shows no apps rather than part of a list when a later page fails', async () => {
    const t = await devicesApp()
    t.devices.apps = manyApps(230)
    t.devices.appReadFaults = ['ok', 503]
    const state = await t.run({ action: 'refresh' })
    expect(state.apps).toMatchObject({ read: 'failed', items: [] })
    expect(state.devices.read).toBe('ready')
  })
})
