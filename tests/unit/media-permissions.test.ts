import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  createSystemMediaPermissions,
  installMediaPermissionPolicy
} from '../../src/main/sensors/media-permissions'
import { createSensorGate } from '../../src/main/sensors/sensor-gate'

describe('createSystemMediaPermissions', () => {
  const system = (status: string, grant = true) => ({
    getMediaAccessStatus: vi.fn<(type: string) => string>(() => status),
    askForMediaAccess: vi.fn<(type: string) => Promise<boolean>>(async () => grant)
  })

  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['restricted', 'restricted'],
    ['not-determined', 'not_determined'],
    ['unknown', 'granted']
  ])('maps the OS status %s to %s', (status, expected) => {
    expect(createSystemMediaPermissions(system(status) as never, 'darwin').status('camera')).toBe(
      expected
    )
  })

  it('asks the OS only on macOS and only when undetermined', async () => {
    const mac = system('not-determined', true)
    const permissions = createSystemMediaPermissions(mac as never, 'darwin')
    expect(await permissions.request('microphone')).toBe('granted')
    expect(mac.askForMediaAccess).toHaveBeenCalledWith('microphone')

    const declined = system('not-determined', false)
    expect(await createSystemMediaPermissions(declined as never, 'darwin').request('camera')).toBe(
      'denied'
    )

    const decided = system('denied')
    expect(await createSystemMediaPermissions(decided as never, 'darwin').request('camera')).toBe(
      'denied'
    )
    expect(decided.askForMediaAccess).not.toHaveBeenCalled()

    const windows = system('not-determined')
    expect(await createSystemMediaPermissions(windows as never, 'win32').request('camera')).toBe(
      'not_determined'
    )
    expect(windows.askForMediaAccess).not.toHaveBeenCalled()
  })

  it('defers to Chromium on platforms without an OS gate', () => {
    const linux = system('denied')
    expect(createSystemMediaPermissions(linux as never, 'linux').status('camera')).toBe('granted')
    expect(linux.getMediaAccessStatus).not.toHaveBeenCalled()
  })
})

describe('installMediaPermissionPolicy', () => {
  const entryUrl = 'file:///jarvis/media/index.html'
  function setup(permitted: ('camera' | 'microphone')[] = []) {
    const media = { isDestroyed: () => false } as unknown as WebContents
    const ui = { isDestroyed: () => false } as unknown as WebContents
    let request: (...args: never[]) => void = () => undefined
    let check: (...args: never[]) => boolean = () => false
    installMediaPermissionPolicy({
      session: {
        setPermissionRequestHandler: (handler) => {
          request = handler as never
        },
        setPermissionCheckHandler: (handler) => {
          check = handler as never
        }
      },
      getMediaContents: () => media,
      entryUrl,
      isKindPermitted: (kind) => permitted.includes(kind)
    })
    const ask = (
      contents: WebContents,
      permission: string,
      details: Record<string, unknown> = { requestingUrl: entryUrl, mediaTypes: ['video'] }
    ) => {
      const callback = vi.fn<(allow: boolean) => void>()
      ;(request as unknown as (...args: unknown[]) => void)(contents, permission, callback, details)
      return callback.mock.calls[0]?.[0]
    }
    const checkPermission = (contents: WebContents, permission: string, url: string) =>
      (check as unknown as (...args: unknown[]) => boolean)(contents, permission, url, {
        requestingUrl: url
      })
    return { media, ui, ask, checkPermission }
  }

  it('allows the media window to open a sensor Main is currently starting', () => {
    const { media, ask } = setup(['camera', 'microphone'])
    expect(ask(media, 'media')).toBe(true)
    expect(ask(media, 'media', { requestingUrl: entryUrl, mediaTypes: ['video', 'audio'] })).toBe(
      true
    )
  })

  it('denies a sensor Main did not ask for, including a mixed request', () => {
    const { media, ask } = setup(['microphone'])
    expect(ask(media, 'media', { requestingUrl: entryUrl, mediaTypes: ['video'] })).toBe(false)
    expect(ask(media, 'media', { requestingUrl: entryUrl, mediaTypes: ['video', 'audio'] })).toBe(
      false
    )
  })

  it('denies the UI window, other documents and every other permission', () => {
    const { media, ui, ask } = setup(['camera', 'microphone'])
    expect(ask(ui, 'media')).toBe(false)
    expect(
      ask(media, 'media', { requestingUrl: 'https://evil.test/', mediaTypes: ['video'] })
    ).toBe(false)
    for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'midi'])
      expect(ask(media, permission)).toBe(false)
  })

  it('lets only the media window read device labels', () => {
    const { media, ui, checkPermission } = setup()
    expect(checkPermission(media, 'media', entryUrl)).toBe(true)
    expect(checkPermission(ui, 'media', entryUrl)).toBe(false)
    expect(checkPermission(media, 'media', 'https://evil.test/')).toBe(false)
    expect(checkPermission(media, 'geolocation', entryUrl)).toBe(false)
  })
})

describe('createSensorGate', () => {
  const user = { userId: 'u', loginId: 'a' }
  const gen = { sessionId: 's', revision: 1 }
  it('opens only for a signed-in, unpaused client', () => {
    let phase: 'checking' | 'signed_out' | 'signed_in' = 'signed_in'
    let paused = false
    const gate = createSensorGate(
      {
        getSnapshot: () =>
          phase === 'signed_in'
            ? { phase, generation: gen, user }
            : { phase, generation: gen, user: null }
      },
      () => paused
    )
    expect(gate.check()).toEqual({ ok: true, value: undefined })
    paused = true
    expect(gate.check()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    paused = false
    for (phase of ['checking', 'signed_out'] as const)
      expect(gate.check()).toMatchObject({ ok: false, error: { code: 'authentication_required' } })
  })
})
