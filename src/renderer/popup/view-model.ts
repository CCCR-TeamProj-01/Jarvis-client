import type { RecommendationCard } from '../../shared/contracts/recommendation'

/** The recommendation card as the popup shows it. */
export interface RecommendationView {
  recommendationId: string
  reason: string
  /** App names in the order the server gave. */
  apps: string[]
  /** An answer is on its way to the server. */
  busy: boolean
}

/** The offer to show, or null when there is none. */
export function recommendationView(
  card: RecommendationCard | null | undefined
): RecommendationView | null {
  if (!card) return null
  return {
    recommendationId: card.recommendationId,
    reason: card.reason,
    apps: [...card.targets]
      .sort((a, b) => a.position - b.position)
      .map((target) => target.displayName),
    busy: card.phase === 'responding'
  }
}
