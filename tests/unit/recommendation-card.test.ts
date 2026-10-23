import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RecommendationCardBody } from '../../src/renderer/popup/recommendation-card'
import type { RecommendationAnswer } from '../../src/shared/contracts/recommendation'
import type { RecommendationView } from '../../src/renderer/popup/view-model'

const view: RecommendationView = {
  recommendationId: '701',
  reason: 'VS Code 다음에 Chrome을 자주 실행했어요.',
  apps: ['Google Chrome'],
  busy: false
}

function props(overrides: Partial<Parameters<typeof RecommendationCardBody>[0]> = {}) {
  return {
    view,
    rejecting: false,
    pauseToday: false,
    onReject: vi.fn<() => void>(),
    onBack: vi.fn<() => void>(),
    onPauseToday: vi.fn<(checked: boolean) => void>(),
    onRespond: vi.fn<(response: RecommendationAnswer['response']) => void>(),
    ...overrides
  }
}

const html = (overrides: Parameters<typeof props>[0] = {}) =>
  renderToStaticMarkup(createElement(RecommendationCardBody, props(overrides)))

/** Every element of the tree the card returns, so a button can be pressed without a browser. */
function elements(node: ReactNode, found: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((child) => elements(child, found))
  else if (isValidElement<Record<string, unknown>>(node)) {
    found.push(node)
    elements(node.props.children as ReactNode, found)
  }
  return found
}
function press(label: string, overrides: Parameters<typeof props>[0] = {}) {
  const p = props(overrides)
  const buttons = elements(RecommendationCardBody(p)).filter((element) => element.type === 'button')
  const nameOf = (element: ReactElement<Record<string, unknown>>) =>
    typeof element.props['aria-label'] === 'string'
      ? element.props['aria-label']
      : typeof element.props.children === 'string'
        ? element.props.children
        : ''
  const button = buttons.find((element) => nameOf(element) === label)
  expect(button, `a button named ${label}`).toBeDefined()
  ;(button!.props.onClick as () => void)()
  return p
}

describe('the recommendation card', () => {
  it('offers run, later and reject, with a close button and a "not today" box', () => {
    const markup = html()
    for (const label of ['실행', '나중에', '거절', '오늘 추천받지 않기'])
      expect(markup).toContain(label)
    expect(markup).toContain('aria-label="닫기"')
    expect(markup).toMatch(/<input[^>]*type="checkbox"/)
    expect(markup).not.toMatch(/<input[^>]*checked/)
    // The reject choices wait for the second step.
    expect(markup).not.toContain('7일간 받지 않기')
    expect(markup).not.toContain('이번만 거절')
  })

  it('asks before rejecting for good: for 7 days, or just this once', () => {
    const markup = html({ rejecting: true })
    expect(markup).toContain('이 앱 조합을 7일 동안 추천받지 않을까요?')
    for (const label of ['7일간 받지 않기', '이번만 거절', '뒤로']) expect(markup).toContain(label)
    // The first step's answers are not on this step, but closing and "not today" still are.
    expect(markup).not.toContain('>실행<')
    expect(markup).not.toContain('>나중에<')
    expect(markup).toContain('aria-label="닫기"')
    expect(markup).toContain('오늘 추천받지 않기')
  })

  it('shows "not today" as checked when it is', () => {
    expect(html({ pauseToday: true })).toMatch(/<input[^>]*checked/)
  })

  it.each([
    ['실행', 'execute'],
    ['나중에', 'snoozed'],
    ['닫기', 'dismiss']
  ] as const)('%s sends %s', (label, response) => {
    const p = press(label)
    expect(p.onRespond).toHaveBeenCalledExactlyOnceWith(response)
  })

  it('reject sends nothing yet, it only moves to the second step', () => {
    const p = press('거절')
    expect(p.onReject).toHaveBeenCalledOnce()
    expect(p.onRespond).not.toHaveBeenCalled()
  })

  it.each([
    ['7일간 받지 않기', 'reject_for_7_days'],
    ['이번만 거절', 'reject_once'],
    ['닫기', 'dismiss']
  ] as const)('on the second step, %s sends %s', (label, response) => {
    const p = press(label, { rejecting: true })
    expect(p.onRespond).toHaveBeenCalledExactlyOnceWith(response)
  })

  it('going back sends nothing', () => {
    const p = press('뒤로', { rejecting: true })
    expect(p.onBack).toHaveBeenCalledOnce()
    expect(p.onRespond).not.toHaveBeenCalled()
  })

  it('locks every control while an answer is on its way', () => {
    for (const rejecting of [false, true]) {
      const markup = html({ view: { ...view, busy: true }, rejecting })
      const controls = markup.match(/<(button|input)\b[^>]*>/g) ?? []
      expect(controls.length).toBeGreaterThan(3)
      for (const control of controls) expect(control).toContain('disabled')
    }
  })

  it('shows the server text as text, not as markup', () => {
    const markup = html({
      view: { ...view, reason: '<img src=x onerror=alert(1)>', apps: ['<b>x</b>'] }
    })
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('<b>')
    expect(markup).toContain('&lt;img')
  })
})
