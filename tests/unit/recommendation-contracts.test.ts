import { describe, expect, it } from 'vitest'
import { ClientSnapshotSchema } from '../../src/shared/contracts/interaction'
import {
  MAX_RECOMMENDATION_APP_NAME_CHARS,
  MAX_RECOMMENDATION_REASON_CHARS,
  MAX_RECOMMENDATION_TARGETS,
  RecommendationCardSchema
} from '../../src/shared/contracts/recommendation'
import { clientSnapshot } from '../fixtures/contracts'

const card = (overrides: Record<string, unknown> = {}) => ({
  recommendationId: '701',
  reason: '자주 함께 쓰는 앱이에요.',
  targets: [{ position: 0, appCode: 'chrome', displayName: 'Google Chrome' }],
  expiresAtUnixMs: 1_000,
  phase: 'offered',
  ...overrides
})

describe('RecommendationCardSchema', () => {
  it('takes a card', () => {
    expect(RecommendationCardSchema.safeParse(card()).success).toBe(true)
  })

  it('takes an app with no code', () => {
    expect(
      RecommendationCardSchema.safeParse(
        card({ targets: [{ position: 0, appCode: null, displayName: 'Slack' }] })
      ).success
    ).toBe(true)
  })

  it.each([
    ['no ID', { recommendationId: '' }],
    ['an ID with surrounding space', { recommendationId: ' 701' }],
    ['an empty reason', { reason: '' }],
    ['a reason that is too long', { reason: 'a'.repeat(MAX_RECOMMENDATION_REASON_CHARS + 1) }],
    ['no apps', { targets: [] }],
    [
      'too many apps',
      {
        targets: Array.from({ length: MAX_RECOMMENDATION_TARGETS + 1 }, (_, index) => ({
          position: index,
          appCode: null,
          displayName: `A${index}`
        }))
      }
    ],
    [
      'an app name that is too long',
      {
        targets: [
          {
            position: 0,
            appCode: null,
            displayName: 'a'.repeat(MAX_RECOMMENDATION_APP_NAME_CHARS + 1)
          }
        ]
      }
    ],
    ['a negative deadline', { expiresAtUnixMs: -1 }],
    ['an unknown phase', { phase: 'approved' }],
    ['an extra field', { runs: 'rm -rf' }]
  ])('refuses a card with %s', (_name, overrides) => {
    expect(RecommendationCardSchema.safeParse(card(overrides)).success).toBe(false)
  })
})

describe('the client snapshot', () => {
  it('has no recommendation by default and accepts one', () => {
    const base = clientSnapshot()
    expect(ClientSnapshotSchema.safeParse(base).success).toBe(true)
    expect(ClientSnapshotSchema.safeParse({ ...base, recommendation: null }).success).toBe(true)
    expect(ClientSnapshotSchema.safeParse({ ...base, recommendation: card() }).success).toBe(true)
  })

  it('refuses a malformed recommendation', () => {
    expect(
      ClientSnapshotSchema.safeParse({ ...clientSnapshot(), recommendation: card({ reason: '' }) })
        .success
    ).toBe(false)
  })
})
