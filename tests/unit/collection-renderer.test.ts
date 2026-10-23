import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CollectionSnapshot } from '../../src/shared/contracts/collection'
import { CollectionPanel } from '../../src/renderer/ui/features/collection/collection-panel'
import { newestCollectionSnapshot } from '../../src/renderer/ui/features/collection/use-collection'
import {
  collectionNotice,
  collectionRows,
  isWorking,
  readProblem
} from '../../src/renderer/ui/features/collection/view-model'

function snapshot(overrides: Partial<CollectionSnapshot> = {}): CollectionSnapshot {
  return {
    revision: 3,
    availability: 'ready',
    read: 'ready',
    settings: { activity: true, external: false },
    stopped: { activity: false, external: false },
    saving: false,
    outcome: null,
    error: null,
    ...overrides
  }
}
const html = (state: CollectionSnapshot | null, error: string | null = null) =>
  renderToStaticMarkup(
    createElement(CollectionPanel, {
      snapshot: state,
      connectionError: error,
      onCommand: () => undefined
    })
  )
const NOW = 1

describe('the activity panel', () => {
  it('shows each flag with its state and a switch that says what it would do', () => {
    const page = html(snapshot())
    expect(page).toContain('자비스 활동 수집')
    expect(page).toContain('외부 앱 활동 수집')
    expect(page).toMatch(/aria-label="자비스 활동 수집"[^>]*aria-checked="true"[^>]*>끄기/)
    expect(page).toMatch(/aria-label="외부 앱 활동 수집"[^>]*aria-checked="false"[^>]*>켜기/)
    expect(page).toContain('켜짐</span>')
    expect(page).toContain('꺼짐</span>')
  })

  it('does not show a value before the settings were read, and does not offer the switch', () => {
    const page = html(snapshot({ read: 'loading', settings: null }))
    expect(page).toContain('설정을 읽고 있어요')
    expect(page).toContain('확인 중')
    expect(page).not.toContain('꺼짐</span>')
    expect(page.match(/role="switch"[^>]*disabled=""/g)?.length).toBe(2)
    expect(html(null)).not.toContain('role="switch"')
  })

  it('says why the settings could not be read, never showing "off" for a value it does not know', () => {
    const failed = html(
      snapshot({
        read: 'failed',
        settings: null,
        error: { code: 'unavailable', message: '서버에 연결할 수 없습니다.' }
      })
    )
    expect(failed).toContain('서버에 연결할 수 없습니다.')
    expect(failed).toContain('확인 중')
    expect(failed).not.toContain('꺼짐</span>')
    const stale = html(
      snapshot({ read: 'failed', error: { code: 'unavailable', message: '연결 실패' } })
    )
    expect(stale).toContain('최신이 아닐 수 있어요')
  })

  it('keeps external switched off and explained while activity is off', () => {
    const page = html(snapshot({ settings: { activity: false, external: false } }))
    expect(page).toContain('자비스 활동 수집을 먼저 켜야 해요')
    expect(page).toMatch(/aria-label="외부 앱 활동 수집"[^>]*disabled=""/)
    expect(page).toMatch(/aria-label="자비스 활동 수집"(?![^>]*disabled)[^>]*>켜기/)
  })

  it('shows a withdrawal the server has not taken as stopped here, with a way to send it again', () => {
    const page = html(
      snapshot({
        settings: { activity: true, external: true },
        stopped: { activity: true, external: true },
        outcome: {
          kind: 'unconfirmed',
          flag: 'activity',
          on: false,
          at: NOW,
          error: { code: 'unavailable', message: 'x' }
        }
      })
    )
    expect(page).toContain('이 기기에서는 멈췄고 서버에는 아직 반영하지 못했어요')
    expect(page).toContain('aria-label="자비스 활동 수집 서버에 다시 반영"')
    expect(page).toContain('꺼짐</span>')
    // The switch is replaced by the retry for that row; the one that is not held keeps its switch.
    expect(page).not.toMatch(/aria-label="자비스 활동 수집"[^>]*role="switch"/)
  })

  it('offers nothing while something is going on', () => {
    const page = html(snapshot({ saving: true }))
    expect(page.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3)
    expect(page).toContain('aria-label="처리 중"')
    expect(isWorking(snapshot({ saving: true }))).toBe(true)
    expect(isWorking(snapshot({ read: 'loading' }))).toBe(true)
    expect(isWorking(snapshot())).toBe(false)
  })

  it('says it is unavailable without a server and offers no switch', () => {
    const page = html(snapshot({ availability: 'unavailable', settings: null }))
    expect(page).toContain('서버에 연결되지 않은 상태')
    expect(page).not.toContain('role="switch"')
    expect(html(null, '앱과 연결하지 못했어요.')).toContain('앱과 연결하지 못했어요.')
  })
})

describe('the words for what happened', () => {
  const outcome = (
    kind: 'saved' | 'failed' | 'unconfirmed',
    flag: 'activity' | 'external',
    on: boolean
  ) =>
    snapshot({
      outcome: {
        kind,
        flag,
        on,
        at: NOW,
        error:
          kind === 'saved'
            ? null
            : { code: 'invalid_input', message: '입력한 내용이 올바르지 않습니다.' }
      }
    })

  it('says each saved change, and that turning activity off takes external with it', () => {
    expect(collectionNotice(outcome('saved', 'activity', true))?.text).toBe(
      '자비스 활동 수집을 켰어요.'
    )
    expect(collectionNotice(outcome('saved', 'external', true))?.text).toBe(
      '외부 앱 활동 수집을 켰어요.'
    )
    expect(collectionNotice(outcome('saved', 'activity', false))?.text).toContain(
      '외부 앱 활동 수집도 함께 꺼졌어요'
    )
    expect(collectionNotice(outcome('saved', 'external', false))?.text).toBe(
      '외부 앱 활동 수집을 껐어요. 서버에도 반영했어요.'
    )
  })

  it('says a withdrawal is held here even when the server did not take it', () => {
    for (const kind of ['failed', 'unconfirmed'] as const)
      expect(collectionNotice(outcome(kind, 'activity', false))).toEqual({
        tone: 'warn',
        text: '자비스 활동 수집은 이 기기에서 멈췄지만 서버에는 반영하지 못했어요. 다시 반영해 주세요.'
      })
  })

  it('tells a refused turning-on in the server’s words as an error, and a lost answer as a doubt', () => {
    expect(collectionNotice(outcome('failed', 'external', true))).toEqual({
      tone: 'error',
      text: '입력한 내용이 올바르지 않습니다.'
    })
    expect(collectionNotice(outcome('unconfirmed', 'external', true))?.tone).toBe('warn')
    expect(collectionNotice(snapshot())).toBeNull()
  })

  it('computes the rows from what the server holds and what was withdrawn here', () => {
    const rows = collectionRows(
      snapshot({
        settings: { activity: true, external: true },
        stopped: { activity: false, external: true }
      })
    )
    expect(rows.map((row) => [row.flag, row.state, row.notApplied, row.enabled])).toEqual([
      ['activity', 'on', false, true],
      ['external', 'off', true, true]
    ])
    expect(
      collectionRows(snapshot({ settings: null })).map((row) => [row.state, row.enabled])
    ).toEqual([
      ['unknown', false],
      ['unknown', false]
    ])
    for (const read of ['idle', 'loading', 'ready'] as const)
      expect(readProblem(snapshot({ read }))).toBeNull()
    expect(
      readProblem(
        snapshot({ read: 'failed', error: { code: 'unavailable', message: '연결 실패' } })
      )
    ).toMatchObject({ tone: 'error' })
  })

  it('does not let a late snapshot replace a newer one', () => {
    const newer = snapshot({ revision: 5 })
    const older = snapshot({ revision: 4 })
    expect(newestCollectionSnapshot(newer, older)).toBe(newer)
    expect(newestCollectionSnapshot(older, newer)).toBe(newer)
    expect(newestCollectionSnapshot(null, older)).toBe(older)
  })
})
