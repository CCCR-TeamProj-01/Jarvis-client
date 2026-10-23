import type { ReactNode } from 'react'
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
  onWakeWordChange?(enabled: boolean): void
  /** The Google Calendar connection, drawn as one more panel. */
  google?: ReactNode
  /** The account's devices, and the apps of this device. */
  devices?: ReactNode
  apps?: ReactNode
}

/** The current settings, for reading. Changing and saving them comes later; this is where it will go. */
export function SettingsView({
  snapshot,
  loginId,
  permissions,
  callKeys,
  toggleKeys,
  onWakeWordChange,
  google,
  devices,
  apps
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
        음성 호출은 이번 실행에만 적용돼요. 다른 설정의 편집·저장은 준비 중이에요.
      </p>

      <div className="panels">
        <section className="panel" aria-labelledby="settings-wake-word">
          <h2 id="settings-wake-word">음성 호출</h2>
          <p className="hint-block">
            켜 두면 이 기기에서 “자비스”를 듣고 대화를 시작해요. 로그아웃하거나 앱을 다시 실행하면
            꺼져요.
          </p>
          <ul className="rows">
            <li className="row">
              <span>
                “자비스”로 호출
                <small>
                  {snapshot.wakeWord?.phase === 'listening'
                    ? '호출을 기다리고 있어요'
                    : snapshot.wakeWord?.phase === 'starting'
                      ? '마이크와 호출어를 준비하고 있어요'
                      : snapshot.wakeWord?.phase === 'suspended'
                        ? '현재 작업이 끝나거나 인식이 재개되면 다시 기다려요'
                        : snapshot.wakeWord?.phase === 'error'
                          ? '호출어 대기가 중단됐어요'
                          : '꺼져 있어요'}
                </small>
              </span>
              <button
                className="button button-ghost"
                type="button"
                role="switch"
                aria-label="자비스 음성 호출"
                aria-checked={snapshot.wakeWord?.enabled ?? false}
                disabled={!onWakeWordChange}
                onClick={() => onWakeWordChange?.(!snapshot.wakeWord?.enabled)}
              >
                {snapshot.wakeWord?.enabled ? '끄기' : '켜기'}
              </button>
            </li>
          </ul>
          {snapshot.wakeWord?.error && (
            <p className="hint-block" role="alert">
              {snapshot.wakeWord.error.message}
            </p>
          )}
        </section>
        {google}
        {devices}
        {apps}
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
