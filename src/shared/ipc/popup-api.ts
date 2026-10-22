import type { Result, Unsubscribe } from '../contracts/common'
import type { RecommendationCard, RecommendationResponse } from '../contracts/recommendation'

/**
 * The recommendation popup gets the card to draw and can send two fixed messages back: the user's
 * answer, and how tall its content is. It has no other channel and cannot start anything itself.
 */
export interface PopupApi {
  getState(): Promise<RecommendationCard | null>
  subscribe(listener: (card: RecommendationCard | null) => void): Unsubscribe
  /** The user's answer. A failure carries wording that is safe to show. */
  respond(recommendationId: string, response: RecommendationResponse): Promise<Result<void>>
  /** How tall the content is, in pixels, so the window can fit it. */
  resize(heightPx: number): void
}

/** The window is no smaller or larger than this, whatever the page asks for. */
export const POPUP_MIN_HEIGHT_PX = 120
export const POPUP_MAX_HEIGHT_PX = 520
