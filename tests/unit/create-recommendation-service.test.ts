import { describe, expect, it, vi } from 'vitest'
import { ServerClient } from '../../src/main/connection/server-client'
import { createRecommendationService } from '../../src/main/recommendation/create-recommendation-service'

const api = new ServerClient({
  baseUrl: 'http://127.0.0.1:1/api/v1',
  fetch,
  accessToken: () => null
})
const base = {
  isPackaged: false,
  env: {},
  api,
  canShow: () => true,
  publish: vi.fn<() => void>()
}

describe('createRecommendationService', () => {
  it('exists with a server', () => {
    expect(createRecommendationService(base)).not.toBeNull()
  })

  it('does not exist without a server', () => {
    expect(createRecommendationService({ ...base, api: null })).toBeNull()
  })

  it('does not exist for the development sign-in stand-in, which the server would not accept', () => {
    expect(createRecommendationService({ ...base, env: { JARVIS_DEV_AUTH: '1' } })).toBeNull()
  })

  it('ignores that switch in a packaged app', () => {
    expect(
      createRecommendationService({ ...base, isPackaged: true, env: { JARVIS_DEV_AUTH: '1' } })
    ).not.toBeNull()
  })

  it('is not affected by the speech stand-in', () => {
    expect(createRecommendationService({ ...base, env: { JARVIS_DEV_SPEECH: '1' } })).not.toBeNull()
  })
})
