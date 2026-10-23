import { useState } from 'react'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import type {
  CollectionCommandRequest,
  CollectionFlag,
  CollectionSnapshot
} from '../../../../shared/contracts/collection'
import { ConfirmDialog, NoticeLine } from '../devices/devices-panel'
import { StatusChip } from '../shell/status-chip'
import {
  FLAG_DETAIL,
  FLAG_LABEL,
  collectionNotice,
  collectionRows,
  isWorking,
  readProblem
} from './view-model'

interface CollectionPanelProps {
  snapshot: CollectionSnapshot | null
  /** The window could not reach Main at all. */
  connectionError: string | null
  onCommand(request: CollectionCommandRequest): void
}

type Asking = { flag: CollectionFlag; on: boolean }

/** The user's say over collecting app activity, in the settings: what is on, and how to turn it off. */
export function CollectionPanel({ snapshot, connectionError, onCommand }: CollectionPanelProps) {
  const [asking, setAsking] = useState<Asking | null>(null)
  const unavailable = snapshot?.availability === 'unavailable'
  const working = snapshot !== null && isWorking(snapshot)
  const rows = snapshot && !unavailable ? collectionRows(snapshot) : []
  const notice = snapshot ? collectionNotice(snapshot) : null
  const problem = snapshot ? readProblem(snapshot) : null
  // Turning off needs no thought; turning external on is a consent and is asked for, as is turning activity off since it takes external with it.
  const choose = (flag: CollectionFlag, on: boolean) => {
    if ((flag === 'external' && on) || (flag === 'activity' && !on)) setAsking({ flag, on })
    else onCommand({ action: 'set', flag, on })
  }
  return (
    <section className="panel" aria-labelledby="settings-collection">
      <h2 id="settings-collection">활동 기록</h2>
      <p className="hint-block hint-block-info">
        자비스로 앱을 열거나 전환한 기록을 서버가 모아 추천에 써요. 언제든 끌 수 있고, 끄면 이
        기기에서는 그 즉시 보내지 않아요.
      </p>
      {connectionError && (
        <p className="notice notice-error" role="alert">
          <CircleAlert aria-hidden="true" />
          {connectionError}
        </p>
      )}
      {unavailable && (
        <p className="hint">서버에 연결되지 않은 상태라 활동 기록 설정을 바꿀 수 없어요.</p>
      )}
      {problem && <NoticeLine notice={problem} />}
      {snapshot && !unavailable && snapshot.settings === null && snapshot.read !== 'failed' && (
        <p className="hint">설정을 읽고 있어요.</p>
      )}
      {rows.length > 0 && snapshot && (
        <ul className="rows">
          {rows.map((row) => (
            <li className="row" key={row.flag}>
              <span>
                {FLAG_LABEL[row.flag]}
                <small>{FLAG_DETAIL[row.flag]}</small>
                {row.blockedReason && <small>{row.blockedReason}</small>}
                {row.notApplied && (
                  <small>이 기기에서는 멈췄고 서버에는 아직 반영하지 못했어요</small>
                )}
              </span>
              <span className="row-actions">
                <StatusChip tone={row.state === 'on' ? 'ok' : 'idle'}>
                  {row.state === 'on' ? '켜짐' : row.state === 'off' ? '꺼짐' : '확인 중'}
                </StatusChip>
                {snapshot.saving && <LoaderCircle className="spin" aria-label="처리 중" />}
                {row.notApplied ? (
                  <button
                    className="button button-ghost"
                    type="button"
                    disabled={working}
                    aria-label={`${FLAG_LABEL[row.flag]} 서버에 다시 반영`}
                    onClick={() => onCommand({ action: 'set', flag: row.flag, on: false })}
                  >
                    다시 반영
                  </button>
                ) : (
                  <button
                    className="button button-ghost"
                    type="button"
                    role="switch"
                    aria-label={FLAG_LABEL[row.flag]}
                    aria-checked={row.state === 'on'}
                    disabled={working || !row.enabled}
                    onClick={() => choose(row.flag, row.state !== 'on')}
                  >
                    {row.state === 'on' ? '끄기' : '켜기'}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {notice && <NoticeLine notice={notice} />}
      {snapshot && !unavailable && (
        <div className="google-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={working}
            onClick={() => onCommand({ action: 'refresh' })}
          >
            {snapshot.read === 'loading' ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : null}
            새로 고침
          </button>
        </div>
      )}
      {asking?.flag === 'external' && (
        <ConfirmDialog
          titleId="collection-external-title"
          title="외부 앱 활동 수집을 켤까요?"
          text="자비스로 앱을 열거나 전환할 때, 그 순간 실행 중이던 다른 앱의 이름도 함께 서버에 보내요. 서버는 이를 추천을 만드는 데 써요. 언제든 다시 끌 수 있어요."
          confirm="동의하고 켜기"
          tone="primary"
          onConfirm={() => {
            setAsking(null)
            onCommand({ action: 'set', flag: 'external', on: true })
          }}
          onClose={() => setAsking(null)}
        />
      )}
      {asking?.flag === 'activity' && (
        <ConfirmDialog
          titleId="collection-activity-title"
          title="자비스 활동 수집을 끌까요?"
          text="이 기기에서 앱 기록을 보내는 것을 바로 멈춰요. 외부 앱 활동 수집도 함께 꺼지고, 새 기록이 없으면 추천도 만들어지지 않아요. 이미 서버에 있는 기록은 지워지지 않아요."
          confirm="끄기"
          onConfirm={() => {
            setAsking(null)
            onCommand({ action: 'set', flag: 'activity', on: false })
          }}
          onClose={() => setAsking(null)}
        />
      )}
    </section>
  )
}
