import type { ClientError, Result } from '../../shared/contracts/common'
import type {
  RecommendationAnswer,
  RecommendationCard
} from '../../shared/contracts/recommendation'
import type { ServerClock } from '../connection/server-clock'
import type { PendingRecommendation, RecommendationApiPort } from './recommendation-api'

export interface RecommendationServiceOptions {
  api: RecommendationApiPort
  /** Wall-clock milliseconds. */
  now(): number
  /** Learned from the server's responses; the server's deadline is judged on its own clock. */
  clock: Pick<ServerClock, 'serverTimeAt'>
  /** Resolves after `ms`, or early when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** Runs `callback` after `delayMs`; returns the function that cancels it. */
  schedule(callback: () => void, delayMs: number): () => void
  /** False while the user is busy with a conversation or speech: nothing new is shown then. */
  canShow(): boolean
  /**
   * True when everything suggested is already running, so there is nothing to suggest. Asked again
   * on the next round, because the user may close the app in the meantime. Left out: always show.
   */
  alreadyOpen?(targets: PendingRecommendation['targets']): Promise<boolean>
  /** The card on offer changed (null when none). */
  publish(card: RecommendationCard | null): void
  /** Fixed wording only. */
  log?(message: string): void
  intervalMs?: number
  maxBackoffMs?: number
}

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000
/** Recommendations already answered in this run; the server should not offer them again. */
const REMEMBERED = 64

const failure = (code: ClientError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message }
})

interface Run {
  userId: string
  abort: AbortController
  done: Promise<void>
}

/**
 * Asks the server which recommendation to offer, shows at most one, and sends the user's answer.
 * Only the server's own deadline decides how long a card stays; it is never counted again from
 * when it arrived. Approving only asks the server, and the commands it creates reach this device
 * through the command poller like any other. Approving and the app having opened are different
 * things, and nothing here treats them alike.
 */
export class RecommendationService {
  private run: Run | null = null
  private card: RecommendationCard | null = null
  private cancelExpiry: (() => void) | null = null
  private readonly answered: string[] = []

  constructor(private readonly options: RecommendationServiceOptions) {}

  start(userId: string): void {
    if (this.run?.userId === userId) return
    void this.stop()
    const abort = new AbortController()
    this.answered.length = 0
    const done = this.loop(abort.signal).catch(() => this.log('추천을 계속 받지 못했어요.'))
    this.run = { userId, abort, done }
  }

  /** Stops asking and takes the card down. */
  stop(): Promise<void> {
    const run = this.run
    this.run = null
    run?.abort.abort()
    this.clear()
    return run?.done ?? Promise.resolve()
  }

  current(): RecommendationCard | null {
    return this.card ? structuredClone(this.card) : null
  }

  /** One round of asking. Returns true when the server could not be reached. */
  async poll(signal: AbortSignal): Promise<boolean> {
    // A card on offer, or one being answered, is the only one there is.
    if (this.card) return false
    if (!this.options.canShow()) return false
    const found = await this.options.api.pending(signal)
    if (!found.ok) return found.error.code !== 'cancelled'
    if (signal.aborted || this.card || found.value === null) return false
    if (await this.options.alreadyOpen?.(found.value.targets)) {
      this.log('추천할 앱이 이미 실행 중이라 보여 주지 않았어요.')
      return false
    }
    // Asking can take a moment; the user may have started something or signed out meanwhile.
    if (signal.aborted || this.card || !this.options.canShow()) return false
    this.offer(found.value)
    return false
  }

  async respond(recommendationId: string, answer: RecommendationAnswer): Promise<Result<void>> {
    const run = this.run
    const card = this.card
    if (!run || !card || card.recommendationId !== recommendationId)
      return failure('not_found', '이미 사라진 추천이에요.')
    if (card.phase === 'responding') return failure('conflict', '답을 보내는 중이에요.')
    if (this.options.now() >= card.expiresAtUnixMs) {
      this.clear()
      return failure('expired', '추천 시간이 지났어요.')
    }
    this.setCard({ ...card, phase: 'responding' })
    const outcome = await this.options.api.respond(recommendationId, answer, run.abort.signal)
    // Signed out or switched while waiting: the answer no longer belongs to anyone on screen.
    if (this.run !== run) return failure('cancelled', '로그인 상태가 바뀌어 중단했어요.')
    if (outcome.kind === 'recorded') {
      this.remember(recommendationId)
      this.clear()
      return { ok: true, value: undefined }
    }
    if (outcome.kind === 'gone') {
      this.remember(recommendationId)
      this.clear()
      switch (outcome.reason) {
        case 'already_responded':
          return failure('conflict', '이미 처리된 추천이에요.')
        case 'expired':
          return failure('expired', '추천 시간이 지났어요.')
        case 'target_unavailable':
          return failure('conflict', '열 수 있는 앱이 없어서 추천을 닫았어요.')
        case 'not_found':
          return failure('not_found', '이미 사라진 추천이에요.')
      }
    }
    // The server did not get it: the card stays, to be answered again until it expires.
    if (this.card?.recommendationId === recommendationId)
      this.setCard({ ...this.card, phase: 'offered' })
    return { ok: false, error: outcome.error }
  }

  // --- internals -------------------------------------------------------------------------------

  private async loop(signal: AbortSignal): Promise<void> {
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS
    const maxBackoff = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    let failures = 0
    while (!signal.aborted) {
      const failed = await this.poll(signal)
      failures = failed ? failures + 1 : 0
      const wait = failures === 0 ? interval : Math.min(interval * 2 ** failures, maxBackoff)
      await this.options.sleep(wait, signal)
    }
  }

  private offer(found: PendingRecommendation): void {
    if (this.answered.includes(found.recommendationId)) return
    const local = this.options.now()
    // The deadline is the server's; this machine's clock may be off, so judge it on theirs.
    const serverNow = this.options.clock.serverTimeAt(local) ?? local
    const remainingMs = found.expiresAtServerMs - serverNow
    if (!(remainingMs > 0)) return
    const expiresAtUnixMs = local + remainingMs
    this.cancelExpiry?.()
    this.cancelExpiry = this.options.schedule(() => {
      if (this.card?.recommendationId === found.recommendationId) this.clear()
    }, remainingMs)
    this.setCard({
      recommendationId: found.recommendationId,
      reason: found.reason,
      targets: found.targets,
      expiresAtUnixMs,
      phase: 'offered'
    })
  }

  private setCard(card: RecommendationCard): void {
    this.card = card
    this.options.publish(structuredClone(card))
  }

  private clear(): void {
    this.cancelExpiry?.()
    this.cancelExpiry = null
    if (this.card === null) return
    this.card = null
    this.options.publish(null)
  }

  private remember(recommendationId: string): void {
    this.answered.push(recommendationId)
    if (this.answered.length > REMEMBERED) this.answered.shift()
  }

  private log(message: string): void {
    this.options.log?.(message)
  }
}
