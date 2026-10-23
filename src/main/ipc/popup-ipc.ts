import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { IdentifierSchema } from '../../shared/contracts/common'
import type { Result } from '../../shared/contracts/common'
import { RecommendationAnswerSchema } from '../../shared/contracts/recommendation'
import type {
  RecommendationAnswer,
  RecommendationCard
} from '../../shared/contracts/recommendation'
import { POPUP_CHANNELS } from '../../shared/ipc/channels'
import { isTrustedSender } from './trusted-sender'

interface PopupIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>
  getContents(): WebContents | null
  entryUrl: string
  getState(): RecommendationCard | null
  respond(recommendationId: string, answer: RecommendationAnswer): Promise<Result<void>>
  resize(heightPx: number): void
}

const refused: Result<never> = {
  ok: false,
  error: { code: 'permission_denied', message: '허용되지 않은 요청이에요.' }
}
const malformed: Result<never> = {
  ok: false,
  error: { code: 'invalid_input', message: '올바르지 않은 요청이에요.' }
}

/** Serves the popup page its card and takes its two messages, from that page only. */
export function registerPopupIpc(options: PopupIpcOptions): () => void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    isTrustedSender(event, options.getContents(), options.entryUrl)
  options.ipc.handle(POPUP_CHANNELS.snapshot, (event) =>
    trusted(event) ? options.getState() : null
  )
  options.ipc.handle(POPUP_CHANNELS.respond, async (event, ...args: unknown[]) => {
    if (!trusted(event)) return refused
    if (args.length !== 2) return malformed
    const id = IdentifierSchema.safeParse(args[0])
    const answer = RecommendationAnswerSchema.safeParse(args[1])
    if (!id.success || !answer.success) return malformed
    return options.respond(id.data, answer.data)
  })
  const onResize = (event: IpcMainEvent, ...args: unknown[]) => {
    if (!trusted(event) || args.length !== 1) return
    const height = args[0]
    if (typeof height !== 'number' || !Number.isFinite(height)) return
    options.resize(height)
  }
  options.ipc.on(POPUP_CHANNELS.resize, onResize)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    options.ipc.removeHandler(POPUP_CHANNELS.snapshot)
    options.ipc.removeHandler(POPUP_CHANNELS.respond)
    options.ipc.removeListener(POPUP_CHANNELS.resize, onResize)
  }
}
