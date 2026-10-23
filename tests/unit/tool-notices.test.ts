import { describe, expect, it, vi } from 'vitest'
import { ToolNotices } from '../../src/main/tools/tool-notices'
import type { ToolNotice } from '../../src/main/tools/tool-notices'

const notice = (overrides: Partial<ToolNotice> = {}): ToolNotice => ({
  type: 'tool',
  requestId: 'cmd-1',
  executionId: 'cmd-1:1',
  text: '계산기를 열었어요.',
  ok: true,
  outcome: 'success',
  ...overrides
})

describe('ToolNotices', () => {
  it('tells every listener, in the order they came', () => {
    const hub = new ToolNotices()
    const order: string[] = []
    hub.subscribe(() => order.push('first'))
    hub.subscribe(() => order.push('second'))
    hub.publish(notice())
    expect(order).toEqual(['first', 'second'])
  })

  it('hands on the notice as it is', () => {
    const hub = new ToolNotices()
    const heard = vi.fn<(notice: ToolNotice) => void>()
    hub.subscribe(heard)
    const sent = notice({ outcome: 'failure', ok: false, text: '앱 전환에 실패했어요.' })
    hub.publish(sent)
    expect(heard).toHaveBeenCalledExactlyOnceWith(sent)
  })

  it('stops telling a listener that unsubscribed, and unsubscribing twice is harmless', () => {
    const hub = new ToolNotices()
    const heard = vi.fn<(notice: ToolNotice) => void>()
    const stop = hub.subscribe(heard)
    stop()
    stop()
    hub.publish(notice())
    expect(heard).not.toHaveBeenCalled()
  })

  it('keeps going when a listener throws', () => {
    const hub = new ToolNotices()
    const heard = vi.fn<(notice: ToolNotice) => void>()
    hub.subscribe(() => {
      throw new Error('listener')
    })
    hub.subscribe(heard)
    expect(() => hub.publish(notice())).not.toThrow()
    expect(heard).toHaveBeenCalledOnce()
  })

  it('has nothing to say to nobody', () => {
    expect(() => new ToolNotices().publish(notice())).not.toThrow()
  })

  it('lets a listener unsubscribe while it is being told, without skipping the next', () => {
    const hub = new ToolNotices()
    const heard = vi.fn<(notice: ToolNotice) => void>()
    const stop = hub.subscribe(() => stop())
    hub.subscribe(heard)
    hub.publish(notice())
    expect(heard).toHaveBeenCalledOnce()
  })
})
