import { useState } from 'react'
import type { FormEvent } from 'react'
import { CircleAlert, Info, LoaderCircle } from 'lucide-react'
import type {
  DeviceCommandRequest,
  DeviceItem,
  DeviceManagementSnapshot
} from '../../../../shared/contracts/devices'
import { useModal } from '../../use-modal'
import { StatusChip } from '../shell/status-chip'
import { deviceDetail, deviceNotice, isWorking, readNotice, renameCheck } from './view-model'
import type { Notice } from './view-model'

interface DevicesPanelProps {
  snapshot: DeviceManagementSnapshot | null
  /** The window could not reach Main at all. */
  connectionError: string | null
  timeZone: string | null
  onCommand(request: DeviceCommandRequest): void
}

type Dialog =
  | { kind: 'rename'; device: DeviceItem }
  | { kind: 'sign_out_device'; device: DeviceItem }
  | { kind: 'sign_out_all' }

/** The account's devices in the settings: who is signed in where, and how to end a session. */
export function DevicesPanel({
  snapshot,
  connectionError,
  timeZone,
  onCommand
}: DevicesPanelProps) {
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const unavailable = snapshot?.availability === 'unavailable'
  const working = snapshot !== null && isWorking(snapshot)
  const notice = snapshot ? deviceNotice(snapshot) : null
  const read = snapshot
    ? readNotice(
        snapshot.devices.read,
        snapshot.devices.error,
        snapshot.devices.items.length > 0,
        '기기 목록'
      )
    : null
  return (
    <section className="panel" aria-labelledby="settings-devices">
      <h2 id="settings-devices">내 기기</h2>
      <p className="hint-block hint-block-info">
        이 계정으로 로그인한 기기예요. 잃어버렸거나 쓰지 않는 기기의 로그인을 끊을 수 있어요. 끊어도
        기기 등록은 남아서 목록에 계속 보여요.
      </p>
      {connectionError && <NoticeLine notice={{ tone: 'error', text: connectionError }} />}
      {unavailable && <p className="hint">서버에 연결되지 않은 상태라 기기를 관리할 수 없어요.</p>}
      {snapshot && !unavailable && (
        <>
          {read && <NoticeLine notice={read} />}
          {snapshot.devices.read === 'loading' && snapshot.devices.items.length === 0 && (
            <p className="hint">기기 목록을 읽고 있어요.</p>
          )}
          {snapshot.devices.read === 'ready' && snapshot.devices.items.length === 0 && (
            <p className="hint">등록된 기기가 없어요.</p>
          )}
          {snapshot.devices.items.length > 0 && (
            <ul className="rows">
              {snapshot.devices.items.map((device) => {
                const busy = snapshot.target === device.id
                return (
                  <li className="row" key={device.id}>
                    <span>
                      {device.name}
                      <small>{deviceDetail(device, timeZone)}</small>
                    </span>
                    <span className="row-actions">
                      {device.current && <StatusChip tone="ok">이 기기</StatusChip>}
                      {!device.current && device.online && (
                        <StatusChip tone="info">온라인</StatusChip>
                      )}
                      {busy && <LoaderCircle className="spin" aria-label="처리 중" />}
                      <button
                        className="button button-ghost"
                        type="button"
                        disabled={working}
                        aria-label={`${device.name} 이름 변경`}
                        onClick={() => setDialog({ kind: 'rename', device })}
                      >
                        이름 변경
                      </button>
                      {!device.current && (
                        <button
                          className="button button-ghost"
                          type="button"
                          disabled={working}
                          aria-label={`${device.name} 로그아웃`}
                          onClick={() => setDialog({ kind: 'sign_out_device', device })}
                        >
                          로그아웃
                        </button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {notice && <NoticeLine notice={notice} />}
          <div className="google-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={working}
              onClick={() => onCommand({ action: 'refresh' })}
            >
              {snapshot.devices.read === 'loading' ? (
                <LoaderCircle className="spin" aria-hidden="true" />
              ) : null}
              새로 고침
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={working}
              onClick={() => setDialog({ kind: 'sign_out_all' })}
            >
              {snapshot.activity === 'signing_out_all' ? (
                <LoaderCircle className="spin" aria-hidden="true" />
              ) : null}
              모든 기기에서 로그아웃
            </button>
          </div>
        </>
      )}
      {!snapshot && !connectionError && <p className="hint">기기 목록을 읽고 있어요.</p>}
      {dialog?.kind === 'rename' && (
        <RenameDialog
          device={dialog.device}
          onSubmit={(name) => {
            setDialog(null)
            onCommand({ action: 'rename_device', deviceId: dialog.device.id, name })
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'sign_out_device' && (
        <ConfirmDialog
          titleId="device-signout-title"
          title={`‘${dialog.device.name}’의 로그인을 끊을까요?`}
          text="그 기기에서는 바로 로그아웃되고, 다시 쓰려면 로그인해야 해요. 기기 등록과 기록은 그대로 남아요."
          confirm="로그아웃시키기"
          onConfirm={() => {
            setDialog(null)
            onCommand({ action: 'sign_out_device', deviceId: dialog.device.id })
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'sign_out_all' && (
        <ConfirmDialog
          titleId="device-signout-all-title"
          title="모든 기기에서 로그아웃할까요?"
          text="이 기기를 포함해 이 계정의 모든 로그인이 끊겨요. 서버가 끊은 것을 확인하면 이 기기도 로그인 화면으로 돌아가요. 서버에서 실패하면 이 기기는 로그인된 채로 남아요."
          confirm="모두 로그아웃"
          onConfirm={() => {
            setDialog(null)
            onCommand({ action: 'sign_out_all' })
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  )
}

/** One line about what happened, drawn the way the other settings panels draw theirs. */
export function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <p
      className={`notice ${notice.tone === 'error' ? 'notice-error' : notice.tone === 'warn' ? 'notice-warning' : ''}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
    >
      {notice.tone === 'error' ? <CircleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
      {notice.text}
    </p>
  )
}

function RenameDialog({
  device,
  onSubmit,
  onClose
}: {
  device: DeviceItem
  onSubmit(name: string): void
  onClose(): void
}) {
  const [name, setName] = useState(device.name)
  const modal = useModal(onClose, false)
  const { valid, canSave } = renameCheck(name, device.name)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (canSave) onSubmit(name)
  }
  return (
    <dialog className="dialog" aria-labelledby="device-rename-title" {...modal}>
      <form onSubmit={submit} noValidate>
        <h2 id="device-rename-title">기기 이름 바꾸기</h2>
        <label className="field">
          <span>이름</span>
          <input
            type="text"
            value={name}
            autoFocus
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {!valid && <p className="field-error">이름은 1자 이상 100자 이하로 입력해 주세요.</p>}
        <div className="dialog-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>
            취소
          </button>
          <button className="button button-primary" type="submit" disabled={!canSave}>
            저장
          </button>
        </div>
      </form>
    </dialog>
  )
}

/** Asks before something that cannot be taken back, and says what goes with it. */
export function ConfirmDialog({
  titleId,
  title,
  text,
  confirm,
  tone = 'danger',
  onConfirm,
  onClose
}: {
  titleId: string
  title: string
  text: string
  confirm: string
  /** `danger` for what takes something away, `primary` for what the user agrees to. */
  tone?: 'danger' | 'primary'
  onConfirm(): void
  onClose(): void
}) {
  const modal = useModal(onClose, false)
  return (
    <dialog className="dialog" aria-labelledby={titleId} {...modal}>
      <h2 id={titleId}>{title}</h2>
      <p className="dialog-text">{text}</p>
      <div className="dialog-actions">
        <button className="button button-secondary" type="button" onClick={onClose}>
          취소
        </button>
        <button
          className={`button ${tone === 'primary' ? 'button-primary' : 'button-danger'}`}
          type="button"
          onClick={onConfirm}
        >
          {confirm}
        </button>
      </div>
    </dialog>
  )
}
