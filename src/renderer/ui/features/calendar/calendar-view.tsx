import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
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
  calendarKeyTarget,
  calendarWeeks,
  selectedCalendarDay,
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
  { navigation: 'this_month', label: '월간' },
  { navigation: 'today', label: '오늘' },
  { navigation: 'tomorrow', label: '내일' },
  { navigation: 'this_week', label: '이번 주' }
]

/** The calendar tab: events and to-dos with a deadline, day by day, for reading. */
export function CalendarView({ snapshot, connectionError, onNavigate }: CalendarViewProps) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const selectedDay = selectedCalendarDay(snapshot?.days ?? [], selectedDate)
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
              className={`button button-secondary${
                (navigation === 'this_month' && snapshot?.view?.span === 'month') ||
                (navigation === 'this_week' && snapshot?.view?.span === 'week')
                  ? ' calendar-shortcut-active'
                  : ''
              }`}
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
      {(body === 'days' || body === 'empty') && snapshot && selectedDay && (
        <div
          className={`calendar-workspace${snapshot.view?.span === 'day' ? ' calendar-workspace-day' : ''}`}
        >
          {snapshot.view?.span !== 'day' && (
            <div className="calendar-board">
              <CalendarGrid
                days={snapshot.days}
                weekStartsOn={snapshot.view?.span === 'week' ? 1 : 0}
                selectedDay={selectedDay}
                title={title}
                onSelect={setSelectedDate}
              />
              <div className="calendar-legend" aria-label="일정 구분">
                <span>
                  <i className="calendar-dot" />
                  자비스 일정
                </span>
                <span>
                  <i className="calendar-dot calendar-dot-google" />
                  Google
                </span>
                <span>
                  <i className="calendar-dot calendar-dot-todo" />
                  마감 할 일
                </span>
              </div>
            </div>
          )}
          <div className="calendar-detail" aria-live="polite" aria-atomic="true">
            <DaySection day={selectedDay} />
          </div>
        </div>
      )}
    </section>
  )
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

function CalendarGrid({
  days,
  weekStartsOn,
  selectedDay,
  title,
  onSelect
}: {
  days: CalendarDay[]
  weekStartsOn: 0 | 1
  selectedDay: CalendarDay
  title: string
  onSelect(date: string): void
}) {
  const weeks = calendarWeeks(days, weekStartsOn)
  const weekdays = [...WEEKDAYS.slice(weekStartsOn), ...WEEKDAYS.slice(0, weekStartsOn)]
  const moveFocus = (event: KeyboardEvent<HTMLTableElement>) => {
    const index = days.findIndex((day) => day.date === selectedDay.date)
    const target = calendarKeyTarget(event.key, index, days.length)
    if (target === null) return
    event.preventDefault()
    const date = days[target]!.date
    onSelect(date)
    event.currentTarget.querySelector<HTMLButtonElement>(`button[data-date="${date}"]`)?.focus()
  }
  return (
    <table className="calendar-grid" aria-label={`${title} 달력`} onKeyDown={moveFocus}>
      <thead>
        <tr>
          {weekdays.map((label) => (
            <th scope="col" key={label}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, row) => (
          <tr key={row}>
            {week.map((day, column) => {
              if (!day) return <td className="calendar-padding" key={`empty-${column}`} />
              const entries = [
                ...day.events.map((item) => ({
                  key: `event-${item.id}`,
                  title: item.title || '(제목 없음)',
                  tone: item.source,
                  label: item.allDay ? '종일' : (item.startTime ?? '계속')
                })),
                ...day.todos.map((item) => ({
                  key: `todo-${item.id}`,
                  title: item.title || '(제목 없음)',
                  tone: 'todo',
                  label: item.done ? '완료' : '할 일'
                }))
              ]
              const selected = day.date === selectedDay.date
              return (
                <td key={day.date}>
                  <button
                    type="button"
                    data-date={day.date}
                    className={`calendar-cell${selected ? ' calendar-cell-selected' : ''}${day.isToday ? ' calendar-cell-today' : ''}`}
                    aria-label={`${dayHeading(day)}, 일정 ${day.events.length}개, 할 일 ${day.todos.length}개`}
                    aria-pressed={selected}
                    aria-current={day.isToday ? 'date' : undefined}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onSelect(day.date)}
                  >
                    <span className="calendar-cell-top">
                      <span className="calendar-cell-number">{Number(day.date.slice(-2))}</span>
                      {day.isToday && <small>오늘</small>}
                    </span>
                    <span className="calendar-previews">
                      {entries.slice(0, 2).map((entry) => (
                        <span
                          className={`calendar-preview calendar-preview-${entry.tone}`}
                          key={entry.key}
                          title={`${entry.label} ${entry.title}`}
                        >
                          <small>{entry.label}</small> {entry.title}
                        </span>
                      ))}
                      {entries.length > 2 && (
                        <span className="calendar-more">+{entries.length - 2}개 더</span>
                      )}
                    </span>
                  </button>
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
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
        <p className="calendar-none">이 날에는 일정과 마감 할 일이 없어요.</p>
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
