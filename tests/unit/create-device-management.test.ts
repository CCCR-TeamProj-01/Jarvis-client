import { describe, expect, it } from 'vitest'
import { ServerClient } from '../../src/main/connection/server-client'
import { createDeviceManagement } from '../../src/main/devices/create-device-management'
import {
  DeviceManagementService,
  UnavailableDeviceManagement
} from '../../src/main/devices/device-management-service'

const api = new ServerClient({
  baseUrl: 'http://127.0.0.1:1/api/v1',
  fetch: async () => {
    throw new Error('no network in this test')
  },
  accessToken: async () => null
})
const end = async () => undefined

describe('choosing the device management', () => {
  it('has none without a server, so the tab says it is unavailable', () => {
    const chosen = createDeviceManagement({
      isPackaged: true,
      env: {},
      api: null,
      endLocalSession: end
    })
    expect(chosen.service).toBeNull()
    expect(chosen.devices).toBeInstanceOf(UnavailableDeviceManagement)
  })

  it('has none with the development sign-in stand-in, which the server would not accept', () => {
    const chosen = createDeviceManagement({
      isPackaged: false,
      env: { JARVIS_DEV_AUTH: '1' },
      api,
      endLocalSession: end
    })
    expect(chosen.service).toBeNull()
    expect(chosen.devices.getSnapshot().availability).toBe('unavailable')
  })

  it('works with a real server and a real login', () => {
    const chosen = createDeviceManagement({ isPackaged: false, env: {}, api, endLocalSession: end })
    expect(chosen.service).toBeInstanceOf(DeviceManagementService)
    expect(chosen.devices).toBe(chosen.service)
    // The stand-in only counts for a development run.
    const packaged = createDeviceManagement({
      isPackaged: true,
      env: { JARVIS_DEV_AUTH: '1' },
      api,
      endLocalSession: end
    })
    expect(packaged.service).toBeInstanceOf(DeviceManagementService)
  })
})
