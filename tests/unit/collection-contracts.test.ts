import { describe, expect, it } from 'vitest'
import {
  CollectionCommandRequestSchema,
  CollectionSnapshotSchema,
  collectionIsOn
} from '../../src/shared/contracts/collection'

const OFF = { activity: false, external: false }

describe('whether a flag is on', () => {
  it('is on only when the server says so and it was not withdrawn here', () => {
    expect(collectionIsOn('activity', { activity: true, external: false }, OFF)).toBe(true)
    expect(collectionIsOn('activity', { activity: false, external: false }, OFF)).toBe(false)
    expect(
      collectionIsOn('activity', { activity: true, external: false }, { ...OFF, activity: true })
    ).toBe(false)
    expect(collectionIsOn('external', { activity: true, external: true }, OFF)).toBe(true)
    expect(
      collectionIsOn('external', { activity: true, external: true }, { ...OFF, external: true })
    ).toBe(false)
  })

  it('never has external on without activity', () => {
    expect(collectionIsOn('external', { activity: false, external: true }, OFF)).toBe(false)
    expect(
      collectionIsOn('external', { activity: true, external: true }, { ...OFF, activity: true })
    ).toBe(false)
  })

  it('is off for everything until the settings were read', () => {
    expect(collectionIsOn('activity', null, OFF)).toBe(false)
    expect(collectionIsOn('external', null, OFF)).toBe(false)
  })
})

describe('the requests the window may send', () => {
  it('accepts a refresh and a switch with exactly their fields', () => {
    for (const request of [
      { action: 'refresh' },
      { action: 'set', flag: 'activity', on: false },
      { action: 'set', flag: 'external', on: true }
    ])
      expect(CollectionCommandRequestSchema.safeParse(request).success).toBe(true)
  })

  it('refuses anything else', () => {
    for (const request of [
      null,
      {},
      { action: 'refresh', flag: 'activity' },
      { action: 'set', flag: 'activity' },
      { action: 'set', on: true },
      { action: 'set', flag: 'timezone', on: true },
      { action: 'set', flag: 'activity', on: 'yes' },
      { action: 'set', flag: 'activity', on: true, revision: 4 },
      { action: 'patch', body: {} }
    ])
      expect(CollectionCommandRequestSchema.safeParse(request).success).toBe(false)
  })

  it('refuses a snapshot with a value it should not carry', () => {
    const base = {
      revision: 1,
      availability: 'ready',
      read: 'ready',
      settings: { activity: true, external: false },
      stopped: OFF,
      saving: false,
      outcome: null,
      error: null
    }
    expect(CollectionSnapshotSchema.safeParse(base).success).toBe(true)
    expect(CollectionSnapshotSchema.safeParse({ ...base, token: 'secret' }).success).toBe(false)
    expect(CollectionSnapshotSchema.safeParse({ ...base, settings: { activity: 1 } }).success).toBe(
      false
    )
  })
})
