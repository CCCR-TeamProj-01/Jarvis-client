import { describe, expect, it, vi } from 'vitest'
import { releaseAll } from '../../src/main/application/release-all'

describe('releaseAll', () => {
  it('runs every release in order', () => {
    const order: string[] = []
    releaseAll([() => order.push('a'), () => order.push('b'), () => order.push('c')])()
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('keeps going when one release fails', () => {
    const later = vi.fn<() => void>()
    expect(() =>
      releaseAll([
        () => {
          throw new Error('first')
        },
        later
      ])()
    ).not.toThrow()
    expect(later).toHaveBeenCalledOnce()
  })

  it('does nothing for an empty list', () => {
    expect(() => releaseAll([])()).not.toThrow()
  })
})
