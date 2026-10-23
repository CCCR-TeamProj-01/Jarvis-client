import { describe, expect, it, vi } from 'vitest'
import type { CollectionConsent } from '../../src/main/commands/activity'
import type {
  CollectionChange,
  CollectionChanged,
  CollectionSettingsApiPort
} from '../../src/main/commands/collection-consent'
import {
  CollectionSettingsService,
  UnavailableCollectionSettings
} from '../../src/main/collection/collection-settings-service'
import type { CollectionEvent } from '../../src/shared/contracts/collection'
import { CollectionSnapshotSchema } from '../../src/shared/contracts/collection'
import type { Result } from '../../src/shared/contracts/common'

const NOW = Date.parse('2026-10-23T03:00:00Z')

/** A server of one user's settings that follows the real one: a change of a flag starts a new revision. */
function setup(
  initial: CollectionConsent = { activityEnabled: true, externalEnabled: true, revision: 3 }
) {
  let server = { ...initial }
  const sent: CollectionChange[] = []
  const events: string[] = []
  const api = {
    read: vi.fn<CollectionSettingsApiPort['read']>(async () => {
      events.push('read')
      return { ok: true, value: { ...server } } as Result<CollectionConsent>
    }),
    change: vi.fn<CollectionSettingsApiPort['change']>(async (change) => {
      events.push('change')
      sent.push(change)
      const next = {
        ...server,
        ...(change.activity === undefined ? {} : { activityEnabled: change.activity }),
        ...(change.external === undefined ? {} : { externalEnabled: change.external })
      }
      if (
        next.activityEnabled !== server.activityEnabled ||
        next.externalEnabled !== server.externalEnabled
      )
        next.revision += 1
      server = next
      return { kind: 'done', value: { ...server } } as CollectionChanged
    })
  }
  const onChanged = vi.fn<() => void>(() => {
    events.push('changed')
  })
  const service = new CollectionSettingsService({ api, now: () => NOW, onChanged })
  const heard: CollectionEvent[] = []
  service.subscribe((event) => heard.push(event))
  service.start('u1')
  const run = async (request: Parameters<CollectionSettingsService['command']>[0]) => {
    const result = await service.command(request)
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  }
  const set = (flag: 'activity' | 'external', on: boolean) => run({ action: 'set', flag, on })
  return {
    api,
    service,
    run,
    set,
    sent,
    events,
    onChanged,
    heard,
    server: () => server,
    setServer: (value: CollectionConsent) => (server = { ...value })
  }
}
const error = { code: 'unavailable', message: '서버에 연결할 수 없습니다.' } as const

describe('reading the settings', () => {
  it('shows the values the server holds and nothing before it was read', async () => {
    const t = setup()
    expect(t.service.getSnapshot()).toMatchObject({ read: 'idle', settings: null })
    const state = await t.run({ action: 'refresh' })
    expect(state).toMatchObject({
      read: 'ready',
      settings: { activity: true, external: true },
      stopped: { activity: false, external: false },
      error: null
    })
    expect(CollectionSnapshotSchema.safeParse(state).success).toBe(true)
  })

  it('says it could not read, and keeps what was read before without calling it current', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.read.mockResolvedValueOnce({ ok: false, error })
    const state = await t.run({ action: 'refresh' })
    expect(state).toMatchObject({ read: 'failed', error, settings: { activity: true } })
    const first = setup()
    first.api.read.mockResolvedValueOnce({ ok: false, error })
    expect(await first.run({ action: 'refresh' })).toMatchObject({ read: 'failed', settings: null })
  })

  it('does not change a switch it has not read', async () => {
    const t = setup()
    const state = await t.set('activity', false)
    expect(t.api.change).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({ kind: 'failed', flag: 'activity', on: false })
    expect(t.onChanged).not.toHaveBeenCalled()
    expect(state.stopped).toEqual({ activity: false, external: false })
  })
})

describe('turning something on', () => {
  it('shows it on only when the server said so, with the values it answered with', async () => {
    const t = setup({ activityEnabled: true, externalEnabled: false, revision: 3 })
    await t.run({ action: 'refresh' })
    let finish: (value: CollectionChanged) => void = () => undefined
    t.api.change.mockImplementationOnce(
      () => new Promise<CollectionChanged>((resolve) => (finish = resolve))
    )
    const pending = t.service.command({ action: 'set', flag: 'external', on: true })
    await vi.waitFor(() => expect(t.service.getSnapshot().saving).toBe(true))
    // Not on yet: nothing was confirmed.
    expect(t.service.getSnapshot().settings).toEqual({ activity: true, external: false })
    expect(t.onChanged).not.toHaveBeenCalled()
    finish({ kind: 'done', value: { activityEnabled: true, externalEnabled: true, revision: 4 } })
    await pending
    expect(t.service.getSnapshot()).toMatchObject({
      saving: false,
      settings: { activity: true, external: true },
      outcome: { kind: 'saved', flag: 'external', on: true, error: null }
    })
    expect(t.onChanged).toHaveBeenCalledTimes(1)
  })

  it('sends only the flag that was asked for', async () => {
    const t = setup({ activityEnabled: false, externalEnabled: false, revision: 1 })
    await t.run({ action: 'refresh' })
    await t.set('activity', true)
    expect(t.sent).toEqual([{ activity: true }])
  })

  it('does not turn external on without activity, and says why', async () => {
    const t = setup({ activityEnabled: false, externalEnabled: false, revision: 1 })
    await t.run({ action: 'refresh' })
    const state = await t.set('external', true)
    expect(t.api.change).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'invalid_input', message: expect.stringContaining('자비스 활동 수집을 먼저') }
    })
  })

  it('does not turn external on while activity is withdrawn here, though the server still has it on', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.change.mockResolvedValueOnce({ kind: 'rejected', error })
    await t.set('activity', false)
    t.api.change.mockClear()
    const state = await t.set('external', true)
    expect(t.api.change).not.toHaveBeenCalled()
    expect(state.outcome).toMatchObject({ kind: 'failed', error: { code: 'invalid_input' } })
  })

  it('leaves everything as it was when the server refuses', async () => {
    const t = setup({ activityEnabled: false, externalEnabled: false, revision: 1 })
    await t.run({ action: 'refresh' })
    t.api.change.mockResolvedValueOnce({
      kind: 'rejected',
      error: { code: 'invalid_input', message: '입력한 내용이 올바르지 않습니다.' }
    })
    const state = await t.set('activity', true)
    expect(state.settings).toEqual({ activity: false, external: false })
    expect(state.stopped).toEqual({ activity: false, external: false })
    expect(state.outcome).toMatchObject({
      kind: 'failed',
      error: { message: '입력한 내용이 올바르지 않습니다.' }
    })
    expect(t.onChanged).not.toHaveBeenCalled()
  })

  it('reads the settings again when the answer was lost, and says it is not sure', async () => {
    const t = setup({ activityEnabled: false, externalEnabled: false, revision: 1 })
    await t.run({ action: 'refresh' })
    t.api.change.mockImplementationOnce(async () => {
      // The server took it; the answer never arrived.
      t.setServer({ activityEnabled: true, externalEnabled: false, revision: 2 })
      return { kind: 'unknown', error }
    })
    const state = await t.set('activity', true)
    expect(state.outcome).toMatchObject({ kind: 'unconfirmed', on: true })
    expect(state.settings).toEqual({ activity: true, external: false })
    expect(t.api.change).toHaveBeenCalledTimes(1)
  })
})

describe('withdrawing', () => {
  it('stops collecting here before the server is even asked', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.events.length = 0
    let finish: (value: CollectionChanged) => void = () => undefined
    t.api.change.mockImplementationOnce(
      () => new Promise<CollectionChanged>((resolve) => (finish = resolve))
    )
    const pending = t.service.command({ action: 'set', flag: 'activity', on: false })
    await vi.waitFor(() => expect(t.service.getSnapshot().saving).toBe(true))
    // The server has not answered; nothing is collected here already.
    expect(t.service.getSnapshot().stopped).toEqual({ activity: true, external: true })
    expect(t.events).toEqual(['changed'])
    const consent = await t.service.read()
    expect(consent).toEqual({
      ok: true,
      value: { activityEnabled: false, externalEnabled: false, revision: 3 }
    })
    finish({ kind: 'done', value: { activityEnabled: false, externalEnabled: false, revision: 4 } })
    await pending
    expect(t.onChanged).toHaveBeenCalledTimes(2)
  })

  it('takes external with it when activity is turned off', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const state = await t.set('activity', false)
    expect(t.sent).toEqual([{ activity: false, external: false }])
    expect(state).toMatchObject({
      settings: { activity: false, external: false },
      // The server shows it off, so it no longer needs holding back here.
      stopped: { activity: false, external: false },
      outcome: { kind: 'saved', flag: 'activity', on: false }
    })
  })

  it('turns external off alone', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const state = await t.set('external', false)
    expect(t.sent).toEqual([{ external: false }])
    expect(state.settings).toEqual({ activity: true, external: false })
  })

  it('keeps collecting stopped here when the server refuses, and says it is not at the server', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.change.mockResolvedValueOnce({ kind: 'rejected', error })
    const state = await t.set('activity', false)
    expect(state).toMatchObject({
      settings: { activity: true, external: true },
      stopped: { activity: true, external: true },
      outcome: { kind: 'failed', flag: 'activity', on: false }
    })
    // The commands still see nothing allowed.
    expect(await t.service.read()).toMatchObject({
      ok: true,
      value: { activityEnabled: false, externalEnabled: false }
    })
    // And sending it again works, and releases the hold because the server now says off.
    const again = await t.set('activity', false)
    expect(t.api.change).toHaveBeenCalledTimes(2)
    expect(again).toMatchObject({
      settings: { activity: false, external: false },
      stopped: { activity: false, external: false },
      outcome: { kind: 'saved' }
    })
  })

  it('stays stopped here when the answer was lost and the server turns out not to have taken it', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.change.mockResolvedValueOnce({ kind: 'unknown', error })
    const state = await t.set('activity', false)
    expect(state.outcome).toMatchObject({ kind: 'unconfirmed', on: false })
    expect(state.settings).toEqual({ activity: true, external: true })
    expect(state.stopped).toEqual({ activity: true, external: true })
  })

  it('lets go of the hold when the server turns out to have taken it', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.change.mockImplementationOnce(async () => {
      t.setServer({ activityEnabled: false, externalEnabled: false, revision: 4 })
      return { kind: 'unknown', error }
    })
    const state = await t.set('activity', false)
    expect(state.stopped).toEqual({ activity: false, external: false })
    expect(state.settings).toEqual({ activity: false, external: false })
  })

  it('lets go of a hold the server has since confirmed off on a later read', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.change.mockResolvedValueOnce({ kind: 'rejected', error })
    await t.set('external', false)
    expect(t.service.getSnapshot().stopped.external).toBe(true)
    t.setServer({ activityEnabled: true, externalEnabled: false, revision: 5 })
    const state = await t.run({ action: 'refresh' })
    expect(state.stopped.external).toBe(false)
  })

  it('lets the user turn it on again, which ends the hold', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.change.mockResolvedValueOnce({ kind: 'rejected', error })
    await t.set('activity', false)
    const state = await t.set('activity', true)
    expect(state.stopped.activity).toBe(false)
    expect(await t.service.read()).toMatchObject({ value: { activityEnabled: true } })
  })

  it('tells the commands to read the consent again at every change', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    await t.set('external', false)
    expect(t.onChanged).toHaveBeenCalledTimes(2)
    await t.set('external', true)
    expect(t.onChanged).toHaveBeenCalledTimes(3)
  })
})

describe('the consent the commands read', () => {
  it('is what the server holds, with its revision', async () => {
    const t = setup()
    expect(await t.service.read()).toEqual({
      ok: true,
      value: { activityEnabled: true, externalEnabled: true, revision: 3 }
    })
  })

  it('never allows external without activity', async () => {
    const t = setup({ activityEnabled: false, externalEnabled: true, revision: 2 })
    expect(await t.service.read()).toMatchObject({
      value: { activityEnabled: false, externalEnabled: false }
    })
  })

  it('gives no consent when the server cannot be asked', async () => {
    const t = setup()
    t.api.read.mockResolvedValueOnce({ ok: false, error })
    expect(await t.service.read()).toEqual({ ok: false, error })
  })

  it('asks the server every time, and passes the signal on', async () => {
    const t = setup()
    const signal = new AbortController().signal
    await t.service.read(signal)
    await t.service.read(signal)
    expect(t.api.read).toHaveBeenCalledTimes(2)
    expect(t.api.read.mock.calls[0]?.[0]).toBe(signal)
  })
})

describe('what the commands read when only external was withdrawn here', () => {
  it('has external off and activity on, whatever the server still holds', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    t.api.change.mockResolvedValueOnce({ kind: 'rejected', error })
    await t.set('external', false)
    expect(await t.service.read()).toEqual({
      ok: true,
      value: { activityEnabled: true, externalEnabled: false, revision: 3 }
    })
  })
})

describe('one thing at a time, and one user at a time', () => {
  it('ignores a request while the settings are being read', async () => {
    const t = setup()
    let finish: (value: Result<CollectionConsent>) => void = () => undefined
    t.api.read.mockImplementationOnce(
      () => new Promise<Result<CollectionConsent>>((resolve) => (finish = resolve))
    )
    const reading = t.service.command({ action: 'refresh' })
    await vi.waitFor(() => expect(t.service.getSnapshot().read).toBe('loading'))
    await t.run({ action: 'refresh' })
    await t.set('activity', false)
    expect(t.api.read).toHaveBeenCalledTimes(1)
    expect(t.api.change).not.toHaveBeenCalled()
    finish({ ok: true, value: { activityEnabled: true, externalEnabled: true, revision: 3 } })
    await reading
    expect(t.service.getSnapshot().read).toBe('ready')
  })

  it('ignores a second request while one is on its way', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    let finish: (value: CollectionChanged) => void = () => undefined
    t.api.change.mockImplementationOnce(
      () => new Promise<CollectionChanged>((resolve) => (finish = resolve))
    )
    const first = t.service.command({ action: 'set', flag: 'external', on: false })
    await vi.waitFor(() => expect(t.service.getSnapshot().saving).toBe(true))
    await t.set('activity', false)
    await t.run({ action: 'refresh' })
    expect(t.api.change).toHaveBeenCalledTimes(1)
    finish({ kind: 'done', value: { activityEnabled: true, externalEnabled: false, revision: 4 } })
    await first
  })

  it('drops an answer that comes after sign-out, and holds the next user to nothing of this one', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    let finish: (value: CollectionChanged) => void = () => undefined
    t.api.change.mockImplementationOnce(
      () => new Promise<CollectionChanged>((resolve) => (finish = resolve))
    )
    const pending = t.service.command({ action: 'set', flag: 'activity', on: false })
    await vi.waitFor(() => expect(t.service.getSnapshot().stopped.activity).toBe(true))
    await t.service.stop()
    t.service.start('u2')
    finish({ kind: 'done', value: { activityEnabled: false, externalEnabled: false, revision: 4 } })
    await pending
    expect(t.service.getSnapshot()).toMatchObject({
      read: 'idle',
      settings: null,
      stopped: { activity: false, external: false },
      saving: false,
      outcome: null
    })
    // The next user is held to nothing the earlier one withdrew here: the server's word is theirs.
    expect(await t.service.read()).toMatchObject({
      value: { activityEnabled: true, externalEnabled: true }
    })
  })

  it('clears the earlier account at once when another takes over', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    const before = t.heard.length
    t.service.start('u2')
    expect(t.heard.length).toBe(before + 1)
    expect(t.service.getSnapshot().settings).toBeNull()
    t.service.start('u2')
    expect(t.heard.length).toBe(before + 1)
  })

  it('answers nobody while no one is signed in', async () => {
    const t = setup()
    await t.service.stop()
    expect(await t.service.command({ action: 'refresh' })).toMatchObject({
      ok: false,
      error: { code: 'authentication_required' }
    })
    expect(t.api.read).not.toHaveBeenCalled()
  })

  it('does not let a failing listener keep the others from hearing', async () => {
    const t = setup()
    const heard = vi.fn<(event: CollectionEvent) => void>()
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

  it('numbers every change', async () => {
    const t = setup()
    await t.run({ action: 'refresh' })
    await t.set('external', false)
    const revisions = t.heard.map((event) => event.snapshot.revision)
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right))
  })
})

describe('when there is no server', () => {
  it('says so and offers nothing', async () => {
    const unavailable = new UnavailableCollectionSettings()
    expect(unavailable.getSnapshot()).toMatchObject({ availability: 'unavailable', settings: null })
    expect(CollectionSnapshotSchema.safeParse(unavailable.getSnapshot()).success).toBe(true)
    expect(await unavailable.command()).toMatchObject({ ok: true })
    expect(unavailable.subscribe()).toBeTypeOf('function')
  })
})
