import { LoaderCircle } from 'lucide-react'
import type {
  DeviceCommandRequest,
  DeviceManagementSnapshot
} from '../../../../shared/contracts/devices'
import { StatusChip } from '../shell/status-chip'
import { NoticeLine } from './devices-panel'
import { appDetail, appNotice, isWorking, readNotice } from './view-model'

interface AppsPanelProps {
  snapshot: DeviceManagementSnapshot | null
  onCommand(request: DeviceCommandRequest): void
}

/** The apps used on this device in the settings, and which of them Jarvis may open and recommend. */
export function AppsPanel({ snapshot, onCommand }: AppsPanelProps) {
  const unavailable = snapshot?.availability === 'unavailable'
  const working = snapshot !== null && isWorking(snapshot)
  const notice = snapshot ? appNotice(snapshot) : null
  const read = snapshot
    ? readNotice(snapshot.apps.read, snapshot.apps.error, snapshot.apps.items.length > 0, '앱 목록')
    : null
  return (
    <section className="panel" aria-labelledby="settings-apps">
      <h2 id="settings-apps">허용 앱</h2>
      <p className="hint-block hint-block-info">
        이 기기에서 자비스로 실행하거나 전환한 앱이에요. 막아 둔 앱은 자비스가 실행하지도,
        추천하지도 않아요. 아직 한 번도 쓰지 않은 앱은 여기에 나타나지 않아요.
      </p>
      {unavailable && <p className="hint">서버에 연결되지 않은 상태라 앱 설정을 바꿀 수 없어요.</p>}
      {snapshot && !unavailable && (
        <>
          {read && <NoticeLine notice={read} />}
          {snapshot.apps.read === 'loading' && snapshot.apps.items.length === 0 && (
            <p className="hint">앱 목록을 읽고 있어요.</p>
          )}
          {snapshot.apps.read === 'ready' && snapshot.apps.items.length === 0 && (
            <p className="hint">아직 자비스로 쓴 앱이 없어요.</p>
          )}
          {snapshot.apps.items.length > 0 && (
            <ul className="rows">
              {snapshot.apps.items.map((app) => (
                <li className="row" key={app.id}>
                  <span>
                    {app.name}
                    <small>{appDetail(app)}</small>
                  </span>
                  <span className="row-actions">
                    <StatusChip tone={app.allowed ? 'ok' : 'idle'}>
                      {app.allowed ? '허용' : '차단'}
                    </StatusChip>
                    {snapshot.target === app.id && (
                      <LoaderCircle className="spin" aria-label="처리 중" />
                    )}
                    <button
                      className="button button-ghost"
                      type="button"
                      role="switch"
                      aria-label={`${app.name} 허용`}
                      aria-checked={app.allowed}
                      disabled={working}
                      onClick={() =>
                        onCommand({
                          action: 'set_app_allowed',
                          appId: app.id,
                          allowed: !app.allowed
                        })
                      }
                    >
                      {app.allowed ? '차단하기' : '허용하기'}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {snapshot.apps.truncated && <p className="hint">앱이 많아서 일부만 보여 줘요.</p>}
          {notice && <NoticeLine notice={notice} />}
        </>
      )}
      {!snapshot && <p className="hint">앱 목록을 읽고 있어요.</p>}
    </section>
  )
}
