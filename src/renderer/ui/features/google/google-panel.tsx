import { useState } from 'react'
import { CircleAlert, Info, LoaderCircle } from 'lucide-react'
import type {
  GoogleAction,
  GoogleConnectionSnapshot
} from '../../../../shared/contracts/google-connection'
import { useModal } from '../../use-modal'
import { StatusChip } from '../shell/status-chip'
import { googleView } from './view-model'
import type { GoogleTone } from './view-model'

const CHIP_TONE: Record<GoogleTone, 'ok' | 'idle' | 'warn' | 'error' | 'info'> = {
  ok: 'ok',
  idle: 'idle',
  warn: 'warn',
  error: 'error',
  info: 'info'
}

interface GooglePanelProps {
  snapshot: GoogleConnectionSnapshot | null
  /** The window could not reach Main at all. */
  connectionError: string | null
  timeZone: string | null
  onCommand(action: GoogleAction): void
}

/** The Google Calendar connection in the settings: the state, and what can be done about it. */
export function GooglePanel({ snapshot, connectionError, timeZone, onCommand }: GooglePanelProps) {
  const [confirming, setConfirming] = useState(false)
  const view = snapshot ? googleView(snapshot, timeZone) : null
  const working = snapshot !== null && (snapshot.activity !== 'none' || snapshot.read === 'loading')
  return (
    <section className="panel" aria-labelledby="settings-google">
      <h2 id="settings-google">Google 캘린더</h2>
      <p className="hint-block hint-block-info">
        연결하면 Google 일정을 서버가 가져와 일정 탭에 읽기 전용으로 보여 줘요. Google 캘린더의
        원본은 바뀌지 않아요.
      </p>
      {connectionError && (
        <p className="notice notice-error" role="alert">
          <CircleAlert aria-hidden="true" />
          {connectionError}
        </p>
      )}
      {view && (
        <>
          <ul className="rows">
            <li className="row">
              <span>
                연결 상태<small>{view.detail}</small>
              </span>
              <StatusChip tone={CHIP_TONE[view.tone]}>{view.chip}</StatusChip>
            </li>
          </ul>
          {view.notice && (
            <p
              className={`notice ${view.notice.tone === 'error' ? 'notice-error' : view.notice.tone === 'warn' ? 'notice-warning' : ''}`}
              role={view.notice.tone === 'error' ? 'alert' : 'status'}
            >
              {view.notice.tone === 'error' ? (
                <CircleAlert aria-hidden="true" />
              ) : (
                <Info aria-hidden="true" />
              )}
              {view.notice.text}
            </p>
          )}
          {view.buttons.length > 0 && (
            <div className="google-actions">
              {view.buttons.map((button) => (
                <button
                  key={button.action}
                  className={`button ${button.primary ? 'button-primary google-primary' : 'button-secondary'}`}
                  type="button"
                  disabled={working && button.action !== 'cancel_connect'}
                  onClick={() =>
                    button.action === 'disconnect' ? setConfirming(true) : onCommand(button.action)
                  }
                >
                  {working && button.primary ? (
                    <LoaderCircle className="spin" aria-hidden="true" />
                  ) : null}
                  {button.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {!view && !connectionError && <p className="hint">연결 상태를 확인하고 있어요.</p>}
      {confirming && (
        <DisconnectDialog
          onConfirm={() => {
            setConfirming(false)
            onCommand('disconnect')
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  )
}

/** Asks before the connection is removed, and says what goes with it. */
export function DisconnectDialog({ onConfirm, onClose }: { onConfirm(): void; onClose(): void }) {
  const modal = useModal(onClose, false)
  return (
    <dialog className="dialog" aria-labelledby="google-disconnect-title" {...modal}>
      <h2 id="google-disconnect-title">Google 캘린더 연결을 해제할까요?</h2>
      <p className="dialog-text">
        서버에 저장된 연결 정보와 가져온 Google 일정이 지워져요. 자비스에서 만든 일정은 그대로 남고,
        Google 캘린더의 원본도 바뀌지 않아요. 다시 연결하면 일정을 새로 가져와요.
      </p>
      <div className="dialog-actions">
        <button className="button button-secondary" type="button" onClick={onClose}>
          취소
        </button>
        <button className="button button-danger" type="button" onClick={onConfirm}>
          연결 해제
        </button>
      </div>
    </dialog>
  )
}
