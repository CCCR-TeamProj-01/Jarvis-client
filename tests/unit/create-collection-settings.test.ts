import { describe, expect, it } from 'vitest'
import { createCollectionSettings } from '../../src/main/collection/create-collection-settings'
import {
  CollectionSettingsService,
  UnavailableCollectionSettings
} from '../../src/main/collection/collection-settings-service'
import { ServerClient } from '../../src/main/connection/server-client'

const api = new ServerClient({
  baseUrl: 'http://127.0.0.1:1/api/v1',
  fetch: async () => {
    throw new Error('no network in this test')
  },
  accessToken: async () => null
})
const onChanged = () => undefined

describe('choosing the collection settings', () => {
  it('has none without a server: the tab says so, and the commands have no consent to go by', () => {
    const chosen = createCollectionSettings({ isPackaged: true, env: {}, api: null, onChanged })
    expect(chosen.service).toBeNull()
    expect(chosen.consent).toBeNull()
    expect(chosen.collection).toBeInstanceOf(UnavailableCollectionSettings)
  })

  it('has none with the development sign-in stand-in, which the server would not accept', () => {
    const chosen = createCollectionSettings({
      isPackaged: false,
      env: { JARVIS_DEV_AUTH: '1' },
      api,
      onChanged
    })
    expect(chosen.service).toBeNull()
    expect(chosen.consent).toBeNull()
    expect(chosen.collection.getSnapshot().availability).toBe('unavailable')
  })

  it('works with a real server, and is what the commands read their consent through', () => {
    const chosen = createCollectionSettings({ isPackaged: false, env: {}, api, onChanged })
    expect(chosen.service).toBeInstanceOf(CollectionSettingsService)
    expect(chosen.collection).toBe(chosen.service)
    expect(chosen.consent).toBe(chosen.service)
    const packaged = createCollectionSettings({
      isPackaged: true,
      env: { JARVIS_DEV_AUTH: '1' },
      api,
      onChanged
    })
    expect(packaged.service).toBeInstanceOf(CollectionSettingsService)
  })
})
