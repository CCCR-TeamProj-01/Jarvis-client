import { describe, expect, it } from 'vitest'
import { recommendationView } from '../../src/renderer/popup/view-model'

describe('recommendationView', () => {
  const card = {
    recommendationId: '701',
    reason: '자주 함께 쓰는 앱이에요.',
    targets: [
      { position: 1, appCode: null, displayName: 'Slack' },
      { position: 0, appCode: 'chrome', displayName: 'Google Chrome' }
    ],
    expiresAtUnixMs: 5,
    phase: 'offered' as const
  }

  it('shows nothing without an offer', () => {
    expect(recommendationView(null)).toBeNull()
    expect(recommendationView(undefined)).toBeNull()
  })

  it('lists the apps in the order the server gave', () => {
    expect(recommendationView(card)).toEqual({
      recommendationId: '701',
      reason: '자주 함께 쓰는 앱이에요.',
      apps: ['Google Chrome', 'Slack'],
      busy: false
    })
  })

  it('marks the card busy while an answer is on its way', () => {
    expect(recommendationView({ ...card, phase: 'responding' })?.busy).toBe(true)
  })

  it('does not change the card it was given', () => {
    const copy = structuredClone(card)
    recommendationView(copy)
    expect(copy).toEqual(card)
  })
})
