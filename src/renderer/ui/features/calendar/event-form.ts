import type {
  CalendarEditOutcome,
  CalendarEventDraft,
  CalendarEventItem
} from '../../../../shared/contracts/calendar'
import type { Result } from '../../../../shared/contracts/common'

/** The add/edit form as the fields hold it: text, as the user typed it. */
export interface EventForm {
  title: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
}

const DEFAULT_START = '09:00'
const DEFAULT_END = '10:00'

/** A new event on a date: an hour from nine in the morning, which the user then changes. */
export function newEventForm(date: string): EventForm {
  return {
    title: '',
    allDay: false,
    startDate: date,
    startTime: DEFAULT_START,
    endDate: date,
    endTime: DEFAULT_END
  }
}

/** The whole event, from its first day to its last, not just the day it was opened from. */
export function formFromEvent(
  event: Pick<CalendarEventItem, 'title' | 'allDay' | 'extent'>
): EventForm {
  const { extent } = event
  return {
    title: event.title,
    allDay: event.allDay,
    startDate: extent.startDate,
    startTime: extent.startTime ?? DEFAULT_START,
    endDate: extent.endDate,
    endTime: extent.endTime ?? DEFAULT_END
  }
}

/** What goes to Main. An all-day event has no times; whatever the fields hold is left behind. */
export function toDraft(form: EventForm): CalendarEventDraft {
  return {
    title: form.title,
    allDay: form.allDay,
    startDate: form.startDate,
    startTime: form.allDay ? null : form.startTime,
    endDate: form.endDate,
    endTime: form.allDay ? null : form.endTime
  }
}

/** Whether there is enough to send; the rest of the checking is Main's, which says what to fix. */
export function canSubmit(form: EventForm): boolean {
  return (
    form.title.trim() !== '' &&
    form.startDate !== '' &&
    form.endDate !== '' &&
    (form.allDay || (form.startTime !== '' && form.endTime !== ''))
  )
}

/** Changing the first day keeps the last day from falling before it. */
export function withStartDate(form: EventForm, startDate: string): EventForm {
  return {
    ...form,
    startDate,
    endDate: startDate !== '' && form.endDate < startDate ? startDate : form.endDate
  }
}

/** What the dialog does next. */
export type EditReport =
  | { kind: 'saved' }
  /** Nothing changed; the message says why. */
  | { kind: 'problem'; message: string }
  /** The server may have taken the change without our hearing. */
  | { kind: 'unknown'; message: string }

const LOST_CONNECTION = '앱과 연결이 끊겨 서버에 전달됐는지 확인하지 못했어요.'

export function editReport(result: Result<CalendarEditOutcome>): EditReport {
  if (!result.ok) {
    // A refused or malformed request never got to Main; a lost connection may have.
    return result.error.code === 'unavailable' || result.error.code === 'internal'
      ? { kind: 'unknown', message: LOST_CONNECTION }
      : { kind: 'problem', message: result.error.message }
  }
  const outcome = result.value
  if (outcome.outcome === 'saved') return { kind: 'saved' }
  if (outcome.outcome === 'not_saved') return { kind: 'problem', message: outcome.error.message }
  return {
    kind: 'unknown',
    message: `${outcome.error.message} 서버가 받았는지 확인하지 못했어요.`
  }
}

/** Where the dialog is: being filled in, being sent, or sent without a clear answer. */
export type DialogPhase = 'editing' | 'saving' | 'unknown'

/**
 * After an unclear answer an add is not offered again: the server does not recognise a repeat of
 * an add, so a second try could make a second event. A change or a delete is the same when it is
 * repeated, and may be tried again.
 */
export const resendBlocked = (mode: 'create' | 'edit', phase: DialogPhase): boolean =>
  mode === 'create' && phase === 'unknown'
