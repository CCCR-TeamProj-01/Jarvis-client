import { describe, expect, it } from 'vitest'
import {
  DeviceCommandRequestSchema,
  DeviceManagementSnapshotSchema,
  isValidDeviceName
} from '../../src/shared/contracts/devices'
import { UnavailableDeviceManagement } from '../../src/main/devices/device-management-service'

describe('the device name rule', () => {
  it('takes 1 to 100 characters once trimmed, counting each character once', () => {
    expect(isValidDeviceName('a')).toBe(true)
    expect(isValidDeviceName('x'.repeat(100))).toBe(true)
    expect(isValidDeviceName('x'.repeat(101))).toBe(false)
    // An emoji is one character, however many UTF-16 units it takes.
    expect(isValidDeviceName('😀'.repeat(100))).toBe(true)
    expect(isValidDeviceName('😀'.repeat(101))).toBe(false)
    expect(isValidDeviceName(`  ${'x'.repeat(100)}  `)).toBe(true)
    expect(isValidDeviceName('')).toBe(false)
    expect(isValidDeviceName('   ')).toBe(false)
  })
})

describe('the requests the window may send', () => {
  it('accepts each action with exactly its own fields', () => {
    for (const request of [
      { action: 'refresh' },
      { action: 'sign_out_all' },
      { action: 'rename_device', deviceId: '13', name: '작업실 PC' },
      { action: 'sign_out_device', deviceId: '13' },
      { action: 'set_app_allowed', appId: '44', allowed: false }
    ])
      expect(DeviceCommandRequestSchema.safeParse(request).success).toBe(true)
  })

  it('refuses extra fields on every action', () => {
    for (const request of [
      { action: 'refresh', x: 1 },
      { action: 'sign_out_all', x: 1 },
      { action: 'rename_device', deviceId: '13', name: 'a', x: 1 },
      { action: 'sign_out_device', deviceId: '13', x: 1 },
      { action: 'set_app_allowed', appId: '44', allowed: true, x: 1 }
    ])
      expect(DeviceCommandRequestSchema.safeParse(request).success).toBe(false)
  })
})

describe('the snapshot', () => {
  const base = new UnavailableDeviceManagement().getSnapshot()
  it('ties a target to an activity about one device or app, and only to that', () => {
    const parse = (change: object) =>
      DeviceManagementSnapshotSchema.safeParse({ ...base, ...change }).success
    expect(parse({})).toBe(true)
    expect(parse({ activity: 'renaming', target: '13' })).toBe(true)
    expect(parse({ activity: 'signing_out_device', target: '13' })).toBe(true)
    expect(parse({ activity: 'setting_app', target: '44' })).toBe(true)
    expect(parse({ activity: 'signing_out_all', target: null })).toBe(true)
    expect(parse({ activity: 'renaming', target: null })).toBe(false)
    expect(parse({ activity: 'none', target: '13' })).toBe(false)
    expect(parse({ activity: 'signing_out_all', target: '13' })).toBe(false)
  })
})
