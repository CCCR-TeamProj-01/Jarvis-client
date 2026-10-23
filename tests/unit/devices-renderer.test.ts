import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  AppItem,
  DeviceItem,
  DeviceManagementSnapshot
} from '../../src/shared/contracts/devices'
import { AppsPanel } from '../../src/renderer/ui/features/devices/apps-panel'
import { DevicesPanel } from '../../src/renderer/ui/features/devices/devices-panel'
import { newestDeviceSnapshot } from '../../src/renderer/ui/features/devices/use-devices'
import {
  appDetail,
  appNotice,
  deviceDetail,
  deviceNotice,
  isWorking,
  lastSeenLabel,
  platformLabel,
  readNotice,
  renameCheck
} from '../../src/renderer/ui/features/devices/view-model'

const SEEN = Date.parse('2026-10-22T05:32:00Z')

const device = (overrides: Partial<DeviceItem> = {}): DeviceItem => ({
  id: '13',
  name: '집 데스크톱',
  platform: 'windows',
  clientVersion: '0.1.0',
  lastSeenAt: SEEN,
  current: false,
  online: false,
  ...overrides
})
const app = (overrides: Partial<AppItem> = {}): AppItem => ({
  id: '44',
  appCode: 'chrome',
  name: 'Google Chrome',
  allowed: true,
  ...overrides
})
function snapshot(overrides: Partial<DeviceManagementSnapshot> = {}): DeviceManagementSnapshot {
  return {
    revision: 3,
    availability: 'ready',
    devices: {
      read: 'ready',
      items: [
        device({ id: '12', name: '내 맥북', platform: 'macos', current: true, online: true }),
        device()
      ],
      error: null
    },
    apps: {
      read: 'ready',
      items: [app(), app({ id: '45', name: 'Slack', allowed: false })],
      truncated: false,
      error: null
    },
    activity: 'none',
    target: null,
    outcome: null,
    ...overrides
  }
}
const noop = () => undefined
const devicesHtml = (state: DeviceManagementSnapshot | null, error: string | null = null) =>
  renderToStaticMarkup(
    createElement(DevicesPanel, {
      snapshot: state,
      connectionError: error,
      timeZone: 'Asia/Seoul',
      onCommand: noop
    })
  )
const appsHtml = (state: DeviceManagementSnapshot | null) =>
  renderToStaticMarkup(createElement(AppsPanel, { snapshot: state, onCommand: noop }))

describe('the devices panel', () => {
  it('lists each device with its system, version and last seen, and marks this one', () => {
    const html = devicesHtml(snapshot())
    expect(html).toContain('내 맥북')
    expect(html).toContain('이 기기')
    expect(html).toContain('macOS · v0.1.0 · 지금 사용 중')
    expect(html).toContain('집 데스크톱')
    // 05:32 UTC is 14:32 in Seoul.
    expect(html).toContain('Windows · v0.1.0 · 마지막 접속 10월 22일 14:32')
  })

  it('offers renaming everywhere but signing out only for the other devices', () => {
    const html = devicesHtml(snapshot())
    expect(html).toContain('aria-label="내 맥북 이름 변경"')
    expect(html).toContain('aria-label="집 데스크톱 이름 변경"')
    expect(html).toContain('aria-label="집 데스크톱 로그아웃"')
    expect(html).not.toContain('aria-label="내 맥북 로그아웃"')
    expect(html).toContain('모든 기기에서 로그아웃')
  })

  it('shows online for another device that was just seen', () => {
    const html = devicesHtml(
      snapshot({
        devices: { read: 'ready', items: [device({ online: true })], error: null }
      })
    )
    expect(html).toContain('온라인')
  })

  it('offers nothing while something is going on, and shows which row is busy', () => {
    const html = devicesHtml(snapshot({ activity: 'signing_out_device', target: '13' }))
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(5)
    expect(html).toContain('aria-label="처리 중"')
    expect(isWorking(snapshot({ activity: 'signing_out_all' }))).toBe(true)
    expect(isWorking(snapshot({ devices: { read: 'loading', items: [], error: null } }))).toBe(true)
    expect(isWorking(snapshot())).toBe(false)
  })

  it('says what is wrong when the list cannot be read, and what is shown is not current', () => {
    const failed = snapshot({
      devices: {
        read: 'failed',
        items: [device()],
        error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
      }
    })
    const html = devicesHtml(failed)
    expect(html).toContain('최신이 아닐 수 있어요')
    expect(html).toContain('집 데스크톱')
    const empty = devicesHtml(
      snapshot({
        devices: {
          read: 'failed',
          items: [],
          error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
        }
      })
    )
    expect(empty).toContain('서버에 연결할 수 없습니다.')
    expect(empty).not.toContain('등록된 기기가 없어요')
  })

  it('tells an empty answer from a list still being read', () => {
    expect(devicesHtml(null)).toContain('기기 목록을 읽고 있어요')
    expect(
      devicesHtml(snapshot({ devices: { read: 'loading', items: [], error: null } }))
    ).toContain('기기 목록을 읽고 있어요')
    expect(devicesHtml(snapshot({ devices: { read: 'ready', items: [], error: null } }))).toContain(
      '등록된 기기가 없어요'
    )
  })

  it('says it is unavailable without a server and offers no action', () => {
    const html = devicesHtml(snapshot({ availability: 'unavailable' }))
    expect(html).toContain('서버에 연결되지 않은 상태')
    expect(html).not.toContain('모든 기기에서 로그아웃')
  })

  it('shows a failure in its own words as an alert, and the other outcomes as status', () => {
    const failed = devicesHtml(
      snapshot({
        outcome: {
          kind: 'failed',
          subject: 'account',
          at: 1,
          error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
        }
      })
    )
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('서버에 연결할 수 없습니다.')
    const done = devicesHtml(
      snapshot({ outcome: { kind: 'renamed', subject: 'device', at: 1, error: null } })
    )
    expect(done).toContain('기기 이름을 바꿨어요.')
    expect(done).not.toContain('role="alert"')
    expect(devicesHtml(null, '앱과 연결하지 못했어요.')).toContain('앱과 연결하지 못했어요.')
  })

  it('renders names as text', () => {
    const html = devicesHtml(
      snapshot({
        devices: {
          read: 'ready',
          items: [device({ name: '<img src=x onerror=alert(1)>' })],
          error: null
        }
      })
    )
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })
})

describe('the allowed-apps panel', () => {
  it('lists each app with whether it is allowed, as a switch', () => {
    const html = appsHtml(snapshot())
    expect(html).toContain('Google Chrome')
    expect(html).toContain('자비스가 실행·전환·추천할 수 있어요')
    expect(html).toContain('aria-label="Google Chrome 허용"')
    expect(html).toMatch(/aria-checked="true"[^>]*>차단하기/)
    expect(html).toContain('Slack')
    expect(html).toContain('자비스가 실행·추천하지 않아요')
    expect(html).toMatch(/aria-checked="false"[^>]*>허용하기/)
    expect(html).toContain('허용</span>')
    expect(html).toContain('차단</span>')
  })

  it('tells an empty list, a failed read, and a cut-short list apart', () => {
    expect(
      appsHtml(snapshot({ apps: { read: 'ready', items: [], truncated: false, error: null } }))
    ).toContain('아직 자비스로 쓴 앱이 없어요')
    const failed = appsHtml(
      snapshot({
        apps: {
          read: 'failed',
          items: [],
          truncated: false,
          error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
        }
      })
    )
    expect(failed).toContain('서버에 연결할 수 없습니다.')
    expect(failed).not.toContain('아직 자비스로 쓴 앱이 없어요')
    expect(
      appsHtml(snapshot({ apps: { read: 'ready', items: [app()], truncated: true, error: null } }))
    ).toContain('일부만 보여 줘요')
    expect(appsHtml(null)).toContain('앱 목록을 읽고 있어요')
  })

  it('disables every switch while a change is on its way', () => {
    const html = appsHtml(snapshot({ activity: 'setting_app', target: '44' }))
    expect(html.match(/role="switch"[^>]*disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(html).toContain('aria-label="처리 중"')
  })

  it('shows only app outcomes here, and device outcomes only in the devices panel', () => {
    const appOutcome = snapshot({
      outcome: { kind: 'app_blocked', subject: 'app', at: 1, error: null }
    })
    expect(appsHtml(appOutcome)).toContain('이 앱을 막았어요')
    expect(devicesHtml(appOutcome)).not.toContain('이 앱을 막았어요')
    const deviceOutcome = snapshot({
      outcome: { kind: 'device_signed_out', subject: 'device', at: 1, error: null }
    })
    expect(devicesHtml(deviceOutcome)).toContain('기기 등록은 남아 있어서')
    expect(appsHtml(deviceOutcome)).not.toContain('기기 등록은 남아 있어서')
  })

  it('says unavailable without a server', () => {
    expect(appsHtml(snapshot({ availability: 'unavailable' }))).toContain(
      '서버에 연결되지 않은 상태'
    )
  })
})

describe('the words for devices and apps', () => {
  it('names systems and last seen', () => {
    expect(platformLabel('windows')).toBe('Windows')
    expect(platformLabel('macos')).toBe('macOS')
    expect(platformLabel('other')).toBe('알 수 없는 운영체제')
    expect(lastSeenLabel(device({ current: true }), null)).toBe('지금 사용 중')
    expect(lastSeenLabel(device({ online: true }), null)).toBe('온라인')
    expect(lastSeenLabel(device({ lastSeenAt: null }), null)).toBe('접속 기록 없음')
    expect(deviceDetail(device({ clientVersion: null, lastSeenAt: null }), null)).toBe(
      'Windows · 접속 기록 없음'
    )
    expect(appDetail(app({ allowed: false }))).toBe('자비스가 실행·추천하지 않아요')
  })

  it('gives a notice for every outcome kind that has wording of its own', () => {
    const kinds = [
      ['renamed', 'device', '기기 이름을 바꿨어요.'],
      ['device_signed_out', 'device', '로그인을 모두 끊었어요'],
      ['device_gone', 'device', '이미 없는 기기'],
      ['app_allowed', 'app', '허용했어요'],
      ['app_blocked', 'app', '막았어요'],
      ['app_gone', 'app', '이미 없는 앱']
    ] as const
    for (const [kind, subject, text] of kinds) {
      const state = snapshot({ outcome: { kind, subject, at: 1, error: null } })
      expect((subject === 'app' ? appNotice(state) : deviceNotice(state))?.text).toContain(text)
    }
    const unconfirmed = snapshot({
      outcome: {
        kind: 'unconfirmed',
        subject: 'account',
        at: 1,
        error: { code: 'unavailable', message: '확인하지 못했어요.' }
      }
    })
    expect(deviceNotice(unconfirmed)).toEqual({ tone: 'warn', text: '확인하지 못했어요.' })
    expect(appNotice(unconfirmed)).toBeNull()
    expect(deviceNotice(snapshot())).toBeNull()
  })

  it('has no read notice for a list that was read', () => {
    expect(readNotice('ready', null, true, '기기 목록')).toBeNull()
    expect(readNotice('loading', null, true, '기기 목록')).toBeNull()
    expect(readNotice('failed', null, false, '기기 목록')?.text).toBe(
      '기기 목록을(를) 읽지 못했어요.'
    )
  })

  it('lets a new name be saved only when it fits the rule and differs from the current one', () => {
    expect(renameCheck('작업실 PC', '집 데스크톱')).toEqual({ valid: true, canSave: true })
    expect(renameCheck('  집 데스크톱  ', '집 데스크톱')).toEqual({ valid: true, canSave: false })
    expect(renameCheck('   ', '집 데스크톱')).toEqual({ valid: false, canSave: false })
    expect(renameCheck('', '집 데스크톱')).toEqual({ valid: false, canSave: false })
    expect(renameCheck('x'.repeat(100), 'a')).toEqual({ valid: true, canSave: true })
    expect(renameCheck('x'.repeat(101), 'a')).toEqual({ valid: false, canSave: false })
  })

  it('does not let a late snapshot replace a newer one', () => {
    const newer = snapshot({ revision: 5 })
    const older = snapshot({ revision: 4 })
    expect(newestDeviceSnapshot(newer, older)).toBe(newer)
    expect(newestDeviceSnapshot(older, newer)).toBe(newer)
    expect(newestDeviceSnapshot(null, older)).toBe(older)
  })
})
