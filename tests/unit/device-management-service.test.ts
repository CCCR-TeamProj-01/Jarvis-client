import { describe, expect, it, vi } from 'vitest'
import type {
  Change,
  DeviceManagementApiPort,
  ServerApp,
  ServerDevice
} from '../../src/main/devices/device-management-api'
import { DeviceManagementService } from '../../src/main/devices/device-management-service'
import { UnavailableDeviceManagement } from '../../src/main/devices/device-management-service'
import type { DeviceManagementEvent } from '../../src/shared/contracts/devices'
import { DeviceManagementSnapshotSchema } from '../../src/shared/contracts/devices'

const NOW = Date.parse('2026-10-23T03:00:00Z')

const device = (overrides: Partial<ServerDevice> = {}): ServerDevice => ({
  id: '12',
  name: '내 맥북',
  platform: 'macos',
  clientVersion: '0.1.0',
  lastSeenAtMs: NOW,
  current: true,
  ...overrides
})
const app = (overrides: Partial<ServerApp> = {}): ServerApp => ({
  id: '44',
  appCode: 'chrome',
  name: 'Google Chrome',
  allowed: true,
  ...overrides
})

type Api = {
  [K in keyof DeviceManagementApiPort]: ReturnType<typeof vi.fn<DeviceManagementApiPort[K]>>
}

function setup(options: { maxAppPages?: number } = {}) {
  const api: Api = {
    devices: vi.fn<DeviceManagementApiPort['devices']>(async () => ({
      ok: true,
      value: [
        device(),
        device({ id: '13', name: '집 데스크톱', current: false, lastSeenAtMs: NOW - 30_000 }),
        device({ id: '14', name: '예전 노트북', current: false, lastSeenAtMs: NOW - 3_600_000 }),
        device({ id: '15', name: '새 기기', current: false, lastSeenAtMs: null })
      ]
    })),
    rename: vi.fn<DeviceManagementApiPort['rename']>(async (_id, name) => ({
      kind: 'done',
      value: { name }
    })),
    signOutDevice: vi.fn<DeviceManagementApiPort['signOutDevice']>(async () => ({
      kind: 'done',
      value: undefined
    })),
    signOutAll: vi.fn<DeviceManagementApiPort['signOutAll']>(async () => ({
      kind: 'done',
      value: undefined
    })),
    apps: vi.fn<DeviceManagementApiPort['apps']>(async () => ({
      ok: true,
      value: {
        items: [app(), app({ id: '45', name: 'Slack', appCode: 'slack', allowed: false })],
        next: null,
        more: false
      }
    })),
    setAppAllowed: vi.fn<DeviceManagementApiPort['setAppAllowed']>(async (_id, allowed) => ({
      kind: 'done',
      value: { allowed }
    }))
  }
  const order: string[] = []
  const endLocalSession = vi.fn<() => Promise<unknown>>(async () => {
    order.push('local sign-out')
  })
  const service = new DeviceManagementService({
    api,
    now: () => NOW,
    clock: { serverTimeAt: (local) => local },
    endLocalSession,
    ...options
  })
  const events: DeviceManagementEvent[] = []
  service.subscribe((event) => events.push(event))
  service.start('u1')
  const run = async (request: Parameters<DeviceManagementService['command']>[0]) => {
    const result = await service.command(request)
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  }
  return { api, service, run, events, endLocalSession, order }
}

describe('reading the devices and apps', () => {
  it('reads both lists, marks this device and judges "online" on the server clock', async () => {
    const t = setup()
    const state = await t.run({ action: 'refresh' })
    expect(state.devices.read).toBe('ready')
    expect(state.devices.items.map((item) => [item.name, item.current, item.online])).toEqual([
      ['내 맥북', true, true],
      ['집 데스크톱', false, true],
      ['예전 노트북', false, false],
      ['새 기기', false, false]
    ])
    expect(state.apps).toMatchObject({ read: 'ready', truncated: false })
    expect(state.apps.items.map((item) => [item.name, item.allowed])).toEqual([
      ['Google Chrome', true],
      ['Slack', false]
    ])
    expect(DeviceManagementSnapshotSchema.safeParse(state).success).toBe(true)
  })

  it('treats a device as online only for a minute after the server last saw it', async () => {
    const t = setup()
    t.api.devices.mockResolvedValueOnce({
      ok: true,
      value: [
        device({ id: '1', current: false, lastSeenAtMs: NOW - 60_000 }),
        device({ id: '2', current: false, lastSeenAtMs: NOW - 60_001 }),
        // Seen "in the future" by a skewed clock is still online.
        device({ id: '3', current: false, lastSeenAtMs: NOW + 5_000 })
      ]
    })
    const state = await t.run({ action: 'refresh' })
    expect(state.devices.items.map((item) => item.online)).toEqual([true, false, true])
  })

  it('judges the age of a device on the server clock when the local clock is off', async () => {
    const t = setup()
    const service = new DeviceManagementService({
      api: t.api,
      now: () => NOW,
      // This computer is an hour behind the server.
      clock: { serverTimeAt: (local) => local + 3_600_000 },
      endLocalSession: async () => undefined
    })
    service.start('u1')
    const result = await service.command({ action: 'refresh' })
    expect(result.ok && result.value.devices.items.map((item) => item.online)).toEqual([
      true,
      false,
      false,
      false
    ])
  })

  it('follows the pages of apps and says when it stopped short', async () => {
    const t = setup({ maxAppPages: 2 })
    const page = (from: number, next: string | null) => ({
      ok: true as const,
      value: {
        items: [app({ id: String(from), name: `앱 ${from}` })],
        next,
        more: next !== null
      }
    })
    t.api.apps.mockResolvedValueOnce(page(1, 'c1')).mockResolvedValueOnce(page(2, 'c2'))
    const state = await t.run({ action: 'refresh' })
    expect(t.api.apps.mock.calls.map((call) => call[0])).toEqual([null, 'c1'])
    expect(state.apps.items.map((item) => item.id)).toEqual(['1', '2'])
    expect(state.apps.truncated).toBe(true)
  })

  it('does not call a list whole when the server says there is more it cannot be followed to', async () => {
    const t = setup()
    t.api.apps.mockResolvedValueOnce({
      ok: true,
      value: { items: [app()], next: null, more: true }
    })
    expect((await t.run({ action: 'refresh' })).apps.truncated).toBe(true)
  })

  it('never shows half of a list as the whole one when a later page fails', async () => {
    const t = setup()
    t.api.apps
      .mockResolvedValueOnce({ ok: true, value: { items: [app()], next: 'c44', more: true } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: '연결 실패' } })
    const state = await t.run({ action: 'refresh' })
    expect(state.apps).toMatchObject({
      read: 'failed',
      items: [],
      error: { message: '연결 실패' }
    })
    // The devices were still read.
    expect(state.devices.read).toBe('ready')
  })

  it('keeps the list shown before when a new read fails, and says so', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.devices.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: '연결 실패' }
    })
    const state = await t.run({ action: 'refresh' })
    expect(state.devices).toMatchObject({ read: 'failed', error: { message: '연결 실패' } })
    expect(state.devices.items).toHaveLength(4)
  })
})

describe('renaming a device', () => {
  it('sends the trimmed name and shows the one the server answered with', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.rename.mockResolvedValueOnce({ kind: 'done', value: { name: '서버가 정한 이름' } })
    const state = await t.run({ action: 'rename_device', deviceId: '13', name: '  작업실 PC  ' })
    expect(t.api.rename.mock.calls[0]?.slice(0, 2)).toEqual(['13', '작업실 PC'])
    expect(state.devices.items.find((item) => item.id === '13')?.name).toBe('서버가 정한 이름')
    expect(state).toMatchObject({
      activity: 'none',
      target: null,
      outcome: { kind: 'renamed', subject: 'device', error: null }
    })
  })

  it('does not send a rename for a device that is not in the list', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const state = await t.run({ action: 'rename_device', deviceId: '99', name: 'x' })
    expect(t.api.rename).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({ kind: 'failed', subject: 'device' })
  })

  it('leaves the name alone when the server refuses, and reads nothing again', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.devices.mockClear()
    t.api.rename.mockResolvedValueOnce({
      kind: 'rejected',
      error: { code: 'invalid_input', message: '입력한 내용이 올바르지 않습니다.' }
    })
    const state = await t.run({ action: 'rename_device', deviceId: '13', name: 'x' })
    expect(state.outcome).toMatchObject({
      kind: 'failed',
      error: { message: '입력한 내용이 올바르지 않습니다.' }
    })
    expect(state.devices.items.find((item) => item.id === '13')?.name).toBe('집 데스크톱')
    expect(t.api.devices).not.toHaveBeenCalled()
  })

  it('reads the list again when the device was already gone', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.rename.mockResolvedValueOnce({ kind: 'not_found' })
    t.api.devices.mockResolvedValueOnce({ ok: true, value: [device()] })
    const state = await t.run({ action: 'rename_device', deviceId: '13', name: 'x' })
    expect(state.outcome).toMatchObject({ kind: 'device_gone', subject: 'device', error: null })
    expect(state.devices.items.map((item) => item.id)).toEqual(['12'])
  })

  it('reports an answer that never came as unconfirmed, and reads the list to show the truth', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.rename.mockResolvedValueOnce({
      kind: 'unknown',
      error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
    })
    t.api.devices.mockResolvedValueOnce({
      ok: true,
      value: [device(), device({ id: '13', name: '작업실 PC', current: false })]
    })
    const state = await t.run({ action: 'rename_device', deviceId: '13', name: '작업실 PC' })
    expect(state.outcome).toMatchObject({ kind: 'unconfirmed', subject: 'device' })
    expect(state.outcome?.error?.message).toContain('확인하지 못했어요')
    expect(state.devices.items.find((item) => item.id === '13')?.name).toBe('작업실 PC')
    // Nothing was sent twice.
    expect(t.api.rename).toHaveBeenCalledTimes(1)
  })
})

describe('ending the sessions of one device', () => {
  it('asks the server and keeps the device in the list', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const state = await t.run({ action: 'sign_out_device', deviceId: '13' })
    expect(t.api.signOutDevice.mock.calls[0]?.[0]).toBe('13')
    expect(state.outcome).toMatchObject({ kind: 'device_signed_out', subject: 'device' })
    expect(state.devices.items.map((item) => item.id)).toContain('13')
    expect(t.endLocalSession).not.toHaveBeenCalled()
  })

  it('refuses this device: it signs out like any sign-out does, not through the list', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const state = await t.run({ action: 'sign_out_device', deviceId: '12' })
    expect(t.api.signOutDevice).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({ kind: 'failed', error: { code: 'invalid_input' } })
  })

  it('does not end a session of a device it has not listed', async () => {
    const t = setup()
    const state = await t.run({ action: 'sign_out_device', deviceId: '13' })
    expect(t.api.signOutDevice).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({ kind: 'failed', error: { code: 'not_found' } })
  })

  it('tells a failure, a vanished device and a lost answer apart', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.signOutDevice.mockResolvedValueOnce({
      kind: 'rejected',
      error: { code: 'permission_denied', message: '권한이 없습니다.' }
    })
    expect((await t.run({ action: 'sign_out_device', deviceId: '13' })).outcome).toMatchObject({
      kind: 'failed'
    })
    t.api.signOutDevice.mockResolvedValueOnce({ kind: 'not_found' })
    expect((await t.run({ action: 'sign_out_device', deviceId: '13' })).outcome).toMatchObject({
      kind: 'device_gone'
    })
    t.api.signOutDevice.mockResolvedValueOnce({
      kind: 'unknown',
      error: { code: 'unavailable', message: 'x' }
    })
    expect((await t.run({ action: 'sign_out_device', deviceId: '13' })).outcome).toMatchObject({
      kind: 'unconfirmed'
    })
  })
})

describe('signing out everywhere', () => {
  it('signs this computer out only after the server said it ended the sessions', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.signOutAll.mockImplementationOnce(async () => {
      t.order.push('server answered')
      return { kind: 'done', value: undefined }
    })
    await t.run({ action: 'sign_out_all' })
    expect(t.order).toEqual(['server answered', 'local sign-out'])
    expect(t.endLocalSession).toHaveBeenCalledTimes(1)
  })

  it('stays signed in when the server fails or refuses', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.signOutAll.mockResolvedValueOnce({
      kind: 'rejected',
      error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
    })
    const state = await t.run({ action: 'sign_out_all' })
    expect(t.endLocalSession).not.toHaveBeenCalled()
    expect(state).toMatchObject({
      activity: 'none',
      outcome: {
        kind: 'failed',
        subject: 'account',
        error: { message: '서버에 연결할 수 없습니다.' }
      }
    })
    expect(state.devices.items).toHaveLength(4)
  })

  it('does not claim success or sign out when the answer is lost, and never sends it again', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.signOutAll.mockResolvedValueOnce({
      kind: 'unknown',
      error: { code: 'unavailable', message: 'x' }
    })
    const state = await t.run({ action: 'sign_out_all' })
    expect(t.endLocalSession).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({ kind: 'unconfirmed', subject: 'account' })
    expect(t.api.signOutAll).toHaveBeenCalledTimes(1)
  })

  it('treats a missing endpoint as a failure, not as being signed out', async () => {
    const t = setup()
    t.api.signOutAll.mockResolvedValueOnce({ kind: 'not_found' })
    const state = await t.run({ action: 'sign_out_all' })
    expect(t.endLocalSession).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({
      kind: 'failed',
      subject: 'account',
      error: { code: 'not_found', message: expect.stringContaining('로그아웃하지 못했어요') }
    })
  })
})

describe('allowing and blocking apps', () => {
  it('changes only what was asked and shows the value the server holds', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const blocked = await t.run({ action: 'set_app_allowed', appId: '44', allowed: false })
    expect(t.api.setAppAllowed.mock.calls[0]?.slice(0, 2)).toEqual(['44', false])
    expect(blocked.apps.items.find((item) => item.id === '44')?.allowed).toBe(false)
    expect(blocked.outcome).toMatchObject({ kind: 'app_blocked', subject: 'app' })
    // The server's word wins when it differs from the request.
    t.api.setAppAllowed.mockResolvedValueOnce({ kind: 'done', value: { allowed: false } })
    const still = await t.run({ action: 'set_app_allowed', appId: '45', allowed: true })
    expect(still.apps.items.find((item) => item.id === '45')?.allowed).toBe(false)
    expect(still.outcome?.kind).toBe('app_blocked')
    const allowed = await t.run({ action: 'set_app_allowed', appId: '44', allowed: true })
    expect(allowed.outcome?.kind).toBe('app_allowed')
  })

  it('does not send a change for an app that is not listed', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const state = await t.run({ action: 'set_app_allowed', appId: '99', allowed: true })
    expect(t.api.setAppAllowed).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({ kind: 'failed', subject: 'app' })
  })

  it('leaves the switch as it was when the server refuses, and reads the apps again after a lost answer or a vanished app', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.setAppAllowed.mockResolvedValueOnce({
      kind: 'rejected',
      error: { code: 'invalid_input', message: '입력한 내용이 올바르지 않습니다.' }
    })
    const refused = await t.run({ action: 'set_app_allowed', appId: '44', allowed: false })
    expect(refused.apps.items.find((item) => item.id === '44')?.allowed).toBe(true)
    expect(refused.outcome).toMatchObject({ kind: 'failed' })

    t.api.apps.mockClear()
    t.api.setAppAllowed.mockResolvedValueOnce({
      kind: 'unknown',
      error: { code: 'unavailable', message: 'x' }
    })
    t.api.apps.mockResolvedValueOnce({
      ok: true,
      value: { items: [app({ allowed: false })], next: null, more: false }
    })
    const lost = await t.run({ action: 'set_app_allowed', appId: '44', allowed: false })
    expect(lost.outcome).toMatchObject({ kind: 'unconfirmed', subject: 'app' })
    expect(lost.apps.items).toEqual([expect.objectContaining({ id: '44', allowed: false })])

    t.api.setAppAllowed.mockResolvedValueOnce({ kind: 'not_found' })
    t.api.apps.mockResolvedValueOnce({ ok: true, value: { items: [], next: null, more: false } })
    const gone = await t.run({ action: 'set_app_allowed', appId: '44', allowed: true })
    expect(gone.outcome).toMatchObject({ kind: 'app_gone', subject: 'app' })
    expect(gone.apps.items).toEqual([])
  })
})

describe('one thing at a time, and one user at a time', () => {
  it('ignores a second request while one is still on its way', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    let finish: (value: Change<{ name: string }>) => void = () => undefined
    t.api.rename.mockImplementationOnce(
      () => new Promise<Change<{ name: string }>>((resolve) => (finish = resolve))
    )
    const first = t.service.command({ action: 'rename_device', deviceId: '13', name: 'a' })
    await vi.waitFor(() => expect(t.service.getSnapshot().activity).toBe('renaming'))
    expect(t.service.getSnapshot().target).toBe('13')
    await t.run({ action: 'sign_out_device', deviceId: '14' })
    await t.run({ action: 'sign_out_all' })
    await t.run({ action: 'refresh' })
    expect(t.api.signOutDevice).not.toHaveBeenCalled()
    expect(t.api.signOutAll).not.toHaveBeenCalled()
    finish({ kind: 'done', value: { name: 'a' } })
    await first
    expect(t.service.getSnapshot().activity).toBe('none')
  })

  it('also ignores requests while only the apps are being read again', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    let finish: () => void = () => undefined
    t.api.setAppAllowed.mockResolvedValueOnce({
      kind: 'unknown',
      error: { code: 'unavailable', message: 'x' }
    })
    t.api.apps.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, value: { items: [], next: null, more: false } })
        })
    )
    const pending = t.service.command({ action: 'set_app_allowed', appId: '44', allowed: false })
    await vi.waitFor(() => expect(t.service.getSnapshot().apps.read).toBe('loading'))
    expect(t.service.getSnapshot()).toMatchObject({ activity: 'none', devices: { read: 'ready' } })
    await t.run({ action: 'sign_out_all' })
    expect(t.api.signOutAll).not.toHaveBeenCalled()
    finish()
    await pending
    expect(t.service.getSnapshot().apps.read).toBe('ready')
  })

  it('clears the last outcome when the next change starts', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    await t.run({ action: 'rename_device', deviceId: '13', name: 'a' })
    expect(t.service.getSnapshot().outcome).toMatchObject({ kind: 'renamed' })
    let finish: (value: Change<{ allowed: boolean }>) => void = () => undefined
    t.api.setAppAllowed.mockImplementationOnce(
      () => new Promise<Change<{ allowed: boolean }>>((resolve) => (finish = resolve))
    )
    const pending = t.service.command({ action: 'set_app_allowed', appId: '44', allowed: false })
    await vi.waitFor(() => expect(t.service.getSnapshot().activity).toBe('setting_app'))
    expect(t.service.getSnapshot().outcome).toBeNull()
    finish({ kind: 'done', value: { allowed: false } })
    await pending
  })

  it('drops an answer that arrives after the user signed out, and shows the next user nothing of this one', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    let finish: (value: Change<{ name: string }>) => void = () => undefined
    t.api.rename.mockImplementationOnce(
      () => new Promise<Change<{ name: string }>>((resolve) => (finish = resolve))
    )
    const pending = t.service.command({ action: 'rename_device', deviceId: '13', name: 'a' })
    await vi.waitFor(() => expect(t.service.getSnapshot().activity).toBe('renaming'))
    await t.service.stop()
    t.service.start('u2')
    finish({ kind: 'done', value: { name: 'a' } })
    await pending
    expect(t.service.getSnapshot()).toMatchObject({
      activity: 'none',
      target: null,
      outcome: null,
      devices: { read: 'idle', items: [] },
      apps: { read: 'idle', items: [] }
    })
  })

  it('clears the earlier account at once when another one takes over', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const before = t.events.length
    t.service.start('u2')
    expect(t.events.length).toBe(before + 1)
    expect(t.service.getSnapshot().devices.items).toEqual([])
    t.service.start('u2')
    expect(t.events.length).toBe(before + 1)
  })

  it('answers nobody while no one is signed in', async () => {
    const t = setup()
    await t.service.stop()
    for (const request of [{ action: 'refresh' }, { action: 'sign_out_all' }] as const)
      expect(await t.service.command(request)).toMatchObject({
        ok: false,
        error: { code: 'authentication_required' }
      })
    expect(t.api.devices).toHaveBeenCalledTimes(0)
    expect(t.api.signOutAll).not.toHaveBeenCalled()
  })

  it('does not let a failing listener keep the others from hearing', async () => {
    const t = setup()
    const heard = vi.fn<(event: DeviceManagementEvent) => void>()
    t.service.subscribe(() => {
      throw new Error('listener failed')
    })
    const unsubscribe = t.service.subscribe(heard)
    await t.run({ action: 'refresh' })
    expect(heard).toHaveBeenCalled()
    unsubscribe()
    heard.mockClear()
    await t.run({ action: 'refresh' })
    expect(heard).not.toHaveBeenCalled()
  })

  it('numbers every change, so a late snapshot can be told from the current one', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const revisions = t.events.map((event) => event.snapshot.revision)
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right))
    expect(new Set(revisions).size).toBe(revisions.length)
  })
})

describe('when there is no server', () => {
  it('says it is unavailable and offers nothing', async () => {
    const unavailable = new UnavailableDeviceManagement()
    expect(unavailable.getSnapshot()).toMatchObject({ availability: 'unavailable' })
    expect(DeviceManagementSnapshotSchema.safeParse(unavailable.getSnapshot()).success).toBe(true)
    expect(await unavailable.command()).toMatchObject({
      ok: true,
      value: { availability: 'unavailable', devices: { items: [] } }
    })
    expect(unavailable.subscribe()).toBeTypeOf('function')
  })
})
