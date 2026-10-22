import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import type { CalendarEventDraft } from '../../../../shared/contracts/calendar'
import { canSubmit, resendBlocked, toDraft, withStartDate } from './event-form'
import type { DialogPhase as Phase, EditReport, EventForm } from './event-form'

/** A modal dialog the browser keeps focus inside; Escape closes it unless something is being sent. */
function useModal(onClose: () => void, locked: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal()
  }, [])
  const props = {
    ref,
    onCancel: (event: { preventDefault(): void }) => {
      event.preventDefault()
      if (!locked) onClose()
    }
  }
  return props
}

interface EventDialogProps {
  mode: 'create' | 'edit'
  initial: EventForm
  /** Sends what the form holds, and says what came of it. */
  onSubmit(draft: CalendarEventDraft): Promise<EditReport>
  /** Closes the dialog. */
  onClose(): void
  /** Closes the dialog and reads the calendar again, to see whether a change went through. */
  onCheck(): void
}

/** Add or edit one event: a title, all day or not, and a start and an end. */
export function EventDialog({ mode, initial, onSubmit, onClose, onCheck }: EventDialogProps) {
  const [form, setForm] = useState(initial)
  const [phase, setPhase] = useState<Phase>('editing')
  const [message, setMessage] = useState<string | null>(null)
  const modal = useModal(onClose, phase === 'saving')
  const adding = mode === 'create'
  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (phase === 'saving' || resendBlocked(mode, phase) || !canSubmit(form)) return
    setPhase('saving')
    setMessage(null)
    const report = await onSubmit(toDraft(form))
    if (report.kind === 'saved') return onClose()
    setMessage(report.message)
    setPhase(report.kind === 'unknown' ? 'unknown' : 'editing')
  }

  // A repeat of an add cannot be told from a second event, so after an unclear answer the add is not offered again.
  const blocked = resendBlocked(mode, phase)
  const saving = phase === 'saving'
  return (
    <dialog className="dialog" aria-labelledby="event-dialog-title" {...modal}>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <h2 id="event-dialog-title">{adding ? '일정 추가' : '일정 수정'}</h2>
        <label className="field">
          <span>제목</span>
          <input
            type="text"
            value={form.title}
            autoFocus
            autoComplete="off"
            disabled={saving || blocked}
            onChange={(event) => set('title', event.target.value)}
          />
        </label>
        <label className="field-check">
          <input
            type="checkbox"
            checked={form.allDay}
            disabled={saving || blocked}
            onChange={(event) => set('allDay', event.target.checked)}
          />
          <span>종일</span>
        </label>
        <div className="field-pair">
          <label className="field">
            <span>{form.allDay ? '시작일' : '시작 날짜'}</span>
            <input
              type="date"
              value={form.startDate}
              disabled={saving || blocked}
              onChange={(event) => setForm(withStartDate(form, event.target.value))}
            />
          </label>
          {!form.allDay && (
            <label className="field">
              <span>시작 시각</span>
              <input
                type="time"
                value={form.startTime}
                disabled={saving || blocked}
                onChange={(event) => set('startTime', event.target.value)}
              />
            </label>
          )}
        </div>
        <div className="field-pair">
          <label className="field">
            <span>{form.allDay ? '종료일 (마지막 날)' : '종료 날짜'}</span>
            <input
              type="date"
              value={form.endDate}
              min={form.startDate || undefined}
              disabled={saving || blocked}
              onChange={(event) => set('endDate', event.target.value)}
            />
          </label>
          {!form.allDay && (
            <label className="field">
              <span>종료 시각</span>
              <input
                type="time"
                value={form.endTime}
                disabled={saving || blocked}
                onChange={(event) => set('endTime', event.target.value)}
              />
            </label>
          )}
        </div>
        {message && (
          <p
            className={`notice ${phase === 'unknown' ? 'notice-warning' : 'notice-error'}`}
            role="alert"
          >
            <CircleAlert aria-hidden="true" />
            <span>
              {message}
              {blocked &&
                ' 같은 일정이 두 번 만들어질 수 있어서 다시 저장하지 않아요. 달력을 새로 불러와 확인해 주세요.'}
            </span>
          </p>
        )}
        <div className="dialog-actions">
          {blocked ? (
            <button className="button button-primary" type="button" onClick={onCheck}>
              닫고 새로 불러오기
            </button>
          ) : (
            <>
              <button
                className="button button-secondary"
                type="button"
                disabled={saving}
                onClick={onClose}
              >
                취소
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={saving || !canSubmit(form)}
              >
                {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
                {saving ? '저장하는 중' : phase === 'unknown' ? '다시 저장' : '저장'}
              </button>
            </>
          )}
        </div>
      </form>
    </dialog>
  )
}

interface DeleteDialogProps {
  title: string
  onConfirm(): Promise<EditReport>
  onClose(): void
}

/** Asks before an event is deleted. */
export function DeleteDialog({ title, onConfirm, onClose }: DeleteDialogProps) {
  const [phase, setPhase] = useState<Phase>('editing')
  const [message, setMessage] = useState<string | null>(null)
  const modal = useModal(onClose, phase === 'saving')
  const saving = phase === 'saving'

  async function confirm() {
    if (saving) return
    setPhase('saving')
    setMessage(null)
    const report = await onConfirm()
    if (report.kind === 'saved') return onClose()
    setMessage(report.message)
    // Deleting twice is the same as deleting once, so it can be tried again.
    setPhase('editing')
  }

  return (
    <dialog className="dialog" aria-labelledby="delete-dialog-title" {...modal}>
      <h2 id="delete-dialog-title">일정을 삭제할까요?</h2>
      <p className="dialog-text">
        <b>{title || '(제목 없음)'}</b> 일정을 취소하고 목록에서 지워요. 예약된 알림도 함께
        취소되고, 되돌리는 기능은 아직 없어요.
      </p>
      {message && (
        <p className="notice notice-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{message}</span>
        </p>
      )}
      <div className="dialog-actions">
        <button
          className="button button-secondary"
          type="button"
          disabled={saving}
          onClick={onClose}
        >
          취소
        </button>
        <button
          className="button button-danger"
          type="button"
          disabled={saving}
          onClick={() => void confirm()}
        >
          {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
          {saving ? '삭제하는 중' : '삭제'}
        </button>
      </div>
    </dialog>
  )
}
