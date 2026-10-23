import { Eye, EyeOff, LoaderCircle } from 'lucide-react'
import type {
  DiagnosticsFrame,
  DiagnosticsSnapshot,
  HandAnalysis
} from '../../../../shared/contracts/gesture-diagnostics'
import { StatusChip } from '../shell/status-chip'
import { HandCanvas } from './hand-canvas'
import { useCalmFrame } from './use-calm-frame'
import {
  fpsText,
  handName,
  noHandText,
  pinchRow,
  reachRows,
  reasonText,
  recognitionStatus
} from './recognition-model'

interface RecognitionPanelProps {
  snapshot: DiagnosticsSnapshot | null
  frame: DiagnosticsFrame | null
  /** The window could not reach Main at all. */
  connectionError: string | null
  onStart(): void
  onStop(): void
}

/** A bar with a mark at the limit; the words beside it say the same, so colour is only a hint. */
function Meter({
  label,
  valueText,
  share,
  mark,
  extraMark,
  ok,
  neutral = false,
  verdict
}: {
  label: string
  valueText: string
  share: number
  mark: number
  extraMark?: number
  ok: boolean
  /** The bar only measures, with no right or wrong side (the pinch): it is not coloured as one. */
  neutral?: boolean
  verdict: string
}) {
  return (
    <li className="meter-row">
      <span className="meter-label">{label}</span>
      <span className="meter" role="img" aria-label={`${label} ${valueText}, ${verdict}`}>
        <span
          className={`meter-fill ${neutral ? (ok ? 'meter-pinch' : 'meter-neutral') : ok ? 'meter-ok' : 'meter-off'}`}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
        <span className="meter-mark" style={{ left: `${Math.round(mark * 100)}%` }} />
        {extraMark !== undefined && (
          <span className="meter-mark" style={{ left: `${Math.round(extraMark * 100)}%` }} />
        )}
      </span>
      <span className="meter-value">
        {valueText}{' '}
        <small className={neutral ? undefined : ok ? 'meter-yes' : 'meter-no'}>{verdict}</small>
      </span>
    </li>
  )
}

export function HandCard({
  hand,
  thresholds,
  lost
}: {
  hand: HandAnalysis
  thresholds: DiagnosticsSnapshot['thresholds']
  /** The tracking has just lost this hand; its last values are shown, dimmed. */
  lost: boolean
}) {
  const reach = reachRows(hand, thresholds)
  const pinch = pinchRow(hand, thresholds)
  return (
    <article
      className={`hand-card${lost ? ' hand-card-lost' : ''}`}
      aria-label={`${handName(hand)} 인식 결과`}
    >
      <header className="hand-card-head">
        <b>
          {handName(hand)}
          {hand.active ? ' · 제어에 쓰는 손' : ''}
        </b>
        <StatusChip tone={hand.pointing ? 'ok' : 'warn'}>
          {hand.pointing ? '포인팅' : '포인팅 아님'}
        </StatusChip>
      </header>
      <p className="hand-reason">{reasonText(hand, thresholds)}</p>
      <ul className="meters" aria-label="손가락 펴진 정도">
        {reach.map((row) => (
          <Meter
            key={row.finger}
            label={row.label}
            valueText={row.value.toFixed(2)}
            share={row.value / 2.4}
            mark={row.mark}
            ok={row.ok}
            verdict={
              row.needs === 'at_least'
                ? row.ok
                  ? '충분히 폄'
                  : '더 펴야 해요'
                : row.ok
                  ? '접힘'
                  : '더 접어야 해요'
            }
          />
        ))}
      </ul>
      {pinch && (
        <ul className="meters" aria-label="엄지와 검지 사이">
          <Meter
            label="Pinch"
            valueText={pinch.value.toFixed(2)}
            share={Math.min(1, pinch.value / 1.2)}
            mark={pinch.enterMark}
            extraMark={pinch.exitMark}
            ok={pinch.pinched}
            neutral
            verdict={pinch.pinched ? '모음(클릭)' : '벌어짐'}
          />
        </ul>
      )}
      <small className="hand-meta">
        {lost
          ? '손을 잠깐 놓쳤어요 · 마지막 값이에요'
          : `신뢰도 ${Math.round(hand.confidence * 100)}%`}
      </small>
    </article>
  )
}

/**
 * The recognition view of the gesture tab: the camera picture with the hands the app sees on it, how
 * far each finger reaches, whether the hand counts as pointing and, if not, why. It never moves the
 * pointer, and what it shows stays on this computer.
 */
export function RecognitionPanel({
  snapshot,
  frame,
  connectionError,
  onStart,
  onStop
}: RecognitionPanelProps) {
  const status = snapshot ? recognitionStatus(snapshot) : null
  const on = snapshot?.state === 'on'
  const calm = useCalmFrame(on ? frame : null)
  const starting = snapshot?.state === 'starting'
  const note = on && (calm?.lostSinceMs ?? null) === null ? noHandText(calm?.frame ?? null) : null
  return (
    <section className="recognition" aria-labelledby="recognition-title">
      <header className="recognition-head">
        <h2 id="recognition-title" className="section-title">
          인식 확인
        </h2>
        {status && <StatusChip tone={status.tone}>{status.chip}</StatusChip>}
        {snapshot && snapshot.availability === 'ready' && (
          <button
            className={`button ${on || starting ? 'button-secondary' : 'button-primary recognition-start'}`}
            type="button"
            disabled={starting}
            onClick={on ? onStop : onStart}
          >
            {starting ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : on ? (
              <EyeOff aria-hidden="true" />
            ) : (
              <Eye aria-hidden="true" />
            )}
            {on ? '확인 끄기' : starting ? '준비 중' : '손 인식 확인'}
          </button>
        )}
      </header>
      {connectionError && (
        <p className="notice notice-error" role="alert">
          {connectionError}
        </p>
      )}
      {status && <p className="hint">{status.detail}</p>}
      {on && snapshot && (
        <div className="recognition-body">
          <div className="hand-stage">
            {frame ? (
              <HandCanvas
                frame={frame}
                thresholds={snapshot.thresholds}
                pictures={snapshot.preview}
              />
            ) : (
              <div className="hand-waiting">첫 화면을 기다리고 있어요.</div>
            )}
            <span className="hand-fps" aria-label="인식 속도">
              {fpsText(calm?.frame.fps ?? null)}
            </span>
            {note && frame && <span className="hand-note">{note}</span>}
          </div>
          <div className="hand-cards">
            {calm?.frame.hands.map((hand) => (
              <HandCard
                key={hand.handId}
                hand={hand}
                thresholds={snapshot.thresholds}
                lost={calm.lostSinceMs !== null}
              />
            ))}
          </div>
        </div>
      )}
      <p className="hint recognition-privacy">
        영상은 이 기기 안에서만 처리돼요. 저장하거나 서버로 보내지 않고, 끄거나 이 화면을 떠나면
        카메라를 돌려줘요.
      </p>
    </section>
  )
}
