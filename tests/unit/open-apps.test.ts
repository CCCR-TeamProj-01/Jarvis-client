import { describe, expect, it, vi } from 'vitest'
import { createOpenAppsCheck } from '../../src/main/recommendation/open-apps'
import type { AppControlPort } from '../../src/main/platform/ports'
import type { Result } from '../../src/shared/contracts/common'
import type { AppDescriptor } from '../../src/shared/contracts/tools'

const chrome = { position: 0, appCode: 'chrome', displayName: 'Google Chrome' }
const slack = { position: 1, appCode: 'slack', displayName: 'Slack' }

function control(apps: Result<AppDescriptor[]>) {
  return { list: vi.fn<AppControlPort['list']>(async () => apps) }
}
const app = (appId: string, state: AppDescriptor['state']): AppDescriptor => ({
  appId,
  displayName: appId,
  state
})

describe('createOpenAppsCheck', () => {
  it('is true when the suggested app is running', async () => {
    const check = createOpenAppsCheck(
      control({ ok: true, value: [app('com.google.Chrome', 'running')] }),
      'darwin'
    )
    expect(await check([chrome])).toBe(true)
  })

  it('is false when it is installed but not running', async () => {
    const check = createOpenAppsCheck(
      control({ ok: true, value: [app('com.google.Chrome', 'stopped')] }),
      'darwin'
    )
    expect(await check([chrome])).toBe(false)
  })

  it('is false when it is not among the apps at all', async () => {
    const check = createOpenAppsCheck(
      control({ ok: true, value: [app('com.apple.Terminal', 'running')] }),
      'darwin'
    )
    expect(await check([chrome])).toBe(false)
  })

  it('needs every suggested app to be running', async () => {
    const some = createOpenAppsCheck(
      control({
        ok: true,
        value: [app('com.google.Chrome', 'running'), app('com.tinyspeck.slackmacgap', 'stopped')]
      }),
      'darwin'
    )
    expect(await some([chrome, slack])).toBe(false)
    const both = createOpenAppsCheck(
      control({
        ok: true,
        value: [app('com.google.Chrome', 'running'), app('com.tinyspeck.slackmacgap', 'running')]
      }),
      'darwin'
    )
    expect(await both([chrome, slack])).toBe(true)
  })

  it('does not take an app of unknown state for a running one', async () => {
    const check = createOpenAppsCheck(
      control({ ok: true, value: [app('com.google.Chrome', 'unknown')] }),
      'darwin'
    )
    expect(await check([chrome])).toBe(false)
  })

  it.each([
    ['an app with no code', { position: 0, appCode: null, displayName: 'Memo' }],
    ['an app code outside the fixed set', { position: 0, appCode: 'photoshop', displayName: 'P' }]
  ])('cannot tell for %s, so it shows the suggestion', async (_name, target) => {
    const list = control({ ok: true, value: [app('com.google.Chrome', 'running')] })
    const check = createOpenAppsCheck(list, 'darwin')
    expect(await check([target])).toBe(false)
    expect(await check([chrome, target])).toBe(false)
  })

  it('cannot tell where the platform has no mapping, without asking for the apps', async () => {
    const list = control({ ok: true, value: [app('chrome.exe', 'running')] })
    expect(await createOpenAppsCheck(list, 'win32')([chrome])).toBe(false)
    expect(list.list).not.toHaveBeenCalled()
  })

  it('shows the suggestion when the app list cannot be read', async () => {
    const check = createOpenAppsCheck(
      control({ ok: false, error: { code: 'unavailable', message: 'x' } }),
      'darwin'
    )
    expect(await check([chrome])).toBe(false)
  })

  it('is false for nothing suggested', async () => {
    const check = createOpenAppsCheck(control({ ok: true, value: [] }), 'darwin')
    expect(await check([])).toBe(false)
  })
})
