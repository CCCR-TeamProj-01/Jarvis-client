import type { ClientSnapshot } from '../../../../shared/contracts/interaction'
import { Info } from 'lucide-react'
import type { PermissionLine } from '../../view-model'
import { Keys, StatusChip } from '../shell/status-chip'

interface SettingsViewProps {
  snapshot: ClientSnapshot
  loginId: string
  permissions: PermissionLine[]
  callKeys: string[]
  toggleKeys: string[]
}

/** The current settings, for reading. Changing and saving them comes later; this is where it will go. */
export function SettingsView({
  snapshot,
  loginId,
  permissions,
  callKeys,
  toggleKeys
}: SettingsViewProps) {
  const shortcut = snapshot.application.shortcut
  const tray = snapshot.application.tray
  return (
    <section className="view" aria-labelledby="settings-title">
      <header className="view-head">
        <h1 id="settings-title">설정</h1>
      </header>
      <p className="notice notice-info">
        <Info aria-hidden="true" />
        지금은 현재 상태를 보는 화면이에요. 설정을 바꾸고 저장하는 기능은 곧 추가돼요.
      </p>

      <div className="panels">
        <section className="panel" aria-labelledby="settings-shortcuts">
          <h2 id="settings-shortcuts">단축키</h2>
          <ul className="rows">
            <li className="row">
              <span>
                호출<small>대화를 바로 시작해요</small>
              </span>
              {shortcut.status === 'registered' ? (
                <Keys keys={callKeys} label="호출 단축키" />
              ) : (
                <StatusChip tone="warn">
                  {shortcut.status === 'pending' ? '준비 중' : '등록하지 못함'}
                </StatusChip>
              )}
            </li>
            <li className="row">
              <span>
                제스처 켜기·끄기<small>언제든 바로 멈출 수 있어요</small>
              </span>
              <Keys keys={toggleKeys} label="제스처 단축키" />
            </li>
          </ul>
          {shortcut.status === 'unavailable' && (
            <p className="hint-block">{shortcut.error.message}</p>
          )}
        </section>

        <section className="panel" aria-labelledby="settings-permissions">
          <h2 id="settings-permissions">권한</h2>
          <ul className="rows">
            {permissions.map((line) => (
              <li className="row" key={line.kind}>
                <span>
                  {line.label}
                  {line.hint && <small>{line.hint}</small>}
                </span>
                <StatusChip tone={line.tone}>{line.value}</StatusChip>
              </li>
            ))}
            <li className="row row-note">
              <span>
                손쉬운 사용<small>제스처로 커서를 움직일 때 필요해요(macOS).</small>
              </span>
            </li>
          </ul>
        </section>

        <section className="panel" aria-labelledby="settings-app">
          <h2 id="settings-app">앱</h2>
          <ul className="rows">
            <li className="row">
              <span>트레이 아이콘</span>
              <StatusChip tone={tray.status === 'ready' ? 'ok' : 'warn'}>
                {tray.status === 'ready'
                  ? '사용 중'
                  : tray.status === 'pending'
                    ? '준비 중'
                    : '사용할 수 없음'}
              </StatusChip>
            </li>
            <li className="row">
              <span>계정</span>
              <b>{loginId}</b>
            </li>
          </ul>
        </section>
      </div>
    </section>
  )
}
