import type { ActiveHandPolicy, HandObservation } from '../../shared/contracts/gesture'

/**
 * Picks the one hand that controls the cursor. `left` and `right` follow that physical hand;
 * `auto_lock` takes the most confident hand and then keeps it for the whole session. A lost hand
 * is never swapped for the other one on the spot: it has to come back (or, for `auto_lock`, be
 * released by `reset`) first.
 */
export class ActiveHandSelector {
  private locked: string | null = null

  constructor(private readonly policy: ActiveHandPolicy) {}

  get activeHandId(): string | null {
    return this.locked
  }

  reset(): void {
    this.locked = null
  }

  select(hands: readonly HandObservation[]): HandObservation | null {
    if (this.policy !== 'auto_lock') {
      const wanted = hands.filter((hand) => hand.handedness === this.policy)
      return best(wanted)
    }
    if (this.locked !== null) return hands.find((hand) => hand.handId === this.locked) ?? null
    const choice = best(hands)
    this.locked = choice?.handId ?? null
    return choice
  }
}

const best = (hands: readonly HandObservation[]): HandObservation | null =>
  hands.reduce<HandObservation | null>(
    (top, hand) => (top === null || hand.confidence > top.confidence ? hand : top),
    null
  )
