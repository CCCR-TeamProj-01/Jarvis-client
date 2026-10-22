import {
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Info,
  ListTodo,
  Lock,
  RefreshCw
} from 'lucide-react'
import type {
  CalendarDay,
  CalendarNavigation,
  CalendarSnapshot
} from '../../../../shared/contracts/calendar'
import {
  calendarBody,
  calendarNotice,
  dayHeading,
  eventTime,
  isReadOnly,
  partLabel,
  sourceLabel,
  todoDue,
  viewTitle
} from './view-model'

interface CalendarViewProps {
  snapshot: CalendarSnapshot | null
  /** The window could not reach Main at all. */
  connectionError: string | null
  onNavigate(navigation: CalendarNavigation): void
}

const SHORTCUTS: { navigation: CalendarNavigation; label: string }[] = [
  { navigation: 'today', label: '오늘' },
  { navigation: 'tomorrow', label: '내일' },
  { navigation: 'this_week', label: '이번 주' }
]

/** The calendar tab: events and to-dos with a deadline, day by day, for reading. */
export function CalendarView({ snapshot, connectionError, onNavigate }: CalendarViewProps) {
  const loading = snapshot === null || snapshot.status === 'loading'
  const body = snapshot ? calendarBody(snapshot) : 'loading'
  const notice = snapshot ? calendarNotice(snapshot) : null
  const title = snapshot?.view ? viewTitle(snapshot.view) : '일정'
  return (
    <section className="view" aria-labelledby="calendar-title">
      <header className="view-head">
        <h1 id="calendar-title">일정</h1>
        {snapshot?.timeZone && <span className="hint">{snapshot.timeZone} 기준</span>}
      </header>

      {snapshot?.days.some((day) => day.events.some((event) => event.source === 'google')) && (
        <p className="notice" role="note">
          <Info aria-hidden="true" />
          Google 일정은 서버에 저장된 읽기 전용 사본이에요. 동기화 상태는 확인할 수 없어요.
        </p>
      )}

      <div className="calendar-bar">
        <div className="calendar-shortcuts" role="group" aria-label="기간 바로가기">
          {SHORTCUTS.map(({ navigation, label }) => (
            <button
              key={navigation}
              className="button button-secondary"
              type="button"
              disabled={loading}
              onClick={() => onNavigate(navigation)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="calendar-step">
          <button
            className="button button-ghost calendar-icon"
            type="button"
            aria-label="이전"
            disabled={loading || !snapshot?.view}
            onClick={() => onNavigate('previous')}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <h2 className="calendar-range" aria-live="polite">
            {title}
          </h2>
          <button
            className="button button-ghost calendar-icon"
            type="button"
            aria-label="다음"
            disabled={loading || !snapshot?.view}
            onClick={() => onNavigate('next')}
          >
            <ChevronRight aria-hidden="true" />
          </button>
          <button
            className="button button-ghost calendar-icon"
            type="button"
            aria-label="새로고침"
            disabled={loading}
            onClick={() => onNavigate('refresh')}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>

      {connectionError && (
        <p className="notice notice-error" role="alert">
          <CircleAlert aria-hidden="true" />
          {connectionError}
        </p>
      )}
      {notice && (
        <p
          className={`notice ${notice.tone === 'error' ? 'notice-error' : ''}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.tone === 'error' ? (
            <CircleAlert aria-hidden="true" />
          ) : (
            <Info aria-hidden="true" />
          )}
          {notice.text}
          {notice.tone === 'error' && !loading && (
            <button
              className="button button-ghost"
              type="button"
              onClick={() => onNavigate('refresh')}
            >
              다시 시도
            </button>
          )}
        </p>
      )}

      {body === 'loading' && (
        <p className="calendar-empty" role="status">
          일정을 불러오고 있어요.
        </p>
      )}
      {body === 'error' && (
        <p className="calendar-empty">일정을 불러오지 못해 보여 드릴 수 없어요.</p>
      )}
      {body === 'empty' && (
        <p className="calendar-empty">
          <CalendarX2 aria-hidden="true" />
          이 기간에는 일정과 마감이 있는 할 일이 없어요.
        </p>
      )}
      {body === 'days' && snapshot && (
        <div className="calendar-days">
          {snapshot.days.map((day) => (
            <DaySection key={day.date} day={day} />
          ))}
        </div>
      )}
    </section>
  )
}

function DaySection({ day }: { day: CalendarDay }) {
  const empty = day.events.length === 0 && day.todos.length === 0
  return (
    <section
      className={`panel calendar-day${day.isToday ? ' calendar-today' : ''}`}
      aria-labelledby={`day-${day.date}`}
    >
      <h3 id={`day-${day.date}`}>
        {dayHeading(day)}
        {day.isToday && <span className="calendar-badge calendar-badge-today">오늘</span>}
      </h3>
      {empty ? (
        <p className="calendar-none">일정 없음</p>
      ) : (
        <ul className="calendar-list">
          {day.events.map((event) => (
            <li className="calendar-item" key={`event-${event.id}`}>
              <span className="calendar-time">{eventTime(event)}</span>
              <span className="calendar-text">
                {event.title || '(제목 없음)'}
                {partLabel(event.part) && <small>{partLabel(event.part)}</small>}
              </span>
              <span className="calendar-tags">
                <span className={`calendar-badge calendar-badge-${event.source}`}>
                  {sourceLabel(event.source)}
                </span>
                {isReadOnly(event.source) && (
                  <span className="calendar-badge calendar-badge-readonly">
                    <Lock aria-hidden="true" />
                    읽기 전용
                  </span>
                )}
              </span>
            </li>
          ))}
          {day.todos.map((todo) => (
            <li
              className={`calendar-item calendar-todo${todo.done ? ' calendar-done' : ''}`}
              key={`todo-${todo.id}`}
            >
              <span className="calendar-time">
                <ListTodo aria-hidden="true" />
                {todoDue(todo)}
              </span>
              <span className="calendar-text">{todo.title || '(제목 없음)'}</span>
              <span className="calendar-tags">
                <span className="calendar-badge">{todo.done ? '완료' : '할 일'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
