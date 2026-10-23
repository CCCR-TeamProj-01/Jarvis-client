import type { Unsubscribe } from '../../shared/contracts/common'
import type { ConversationNotice } from '../conversation/ports'

/** The words for what a tool or command did: a line in the conversation and a pill on the overlay. */
export type ToolNotice = Extract<ConversationNotice, { type: 'tool' }>

/**
 * Where results of work done on this computer are announced, whoever asked for it (the assistant
 * running here, or a command the server sent). Everything that shows results listens here.
 */
export class ToolNotices {
  private readonly listeners = new Set<(notice: ToolNotice) => void>()

  subscribe(listener: (notice: ToolNotice) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(notice: ToolNotice): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notice)
      } catch {
        /* A listener that fails must not stop the others. */
      }
    }
  }
}
