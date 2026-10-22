import type { ReactNode } from 'react'
import {
  CalendarDays,
  LogOut,
  MessageSquare,
  MousePointer2,
  Power,
  SlidersHorizontal
} from 'lucide-react'
import type { Tab } from '../../../../shared/contracts/interaction'

const TABS: { tab: Tab; label: string; Icon: typeof MessageSquare }[] = [
  { tab: 'conversation', label: '대화', Icon: MessageSquare },
  { tab: 'calendar', label: '일정', Icon: CalendarDays },
  { tab: 'gesture', label: '제스처', Icon: MousePointer2 },
  { tab: 'settings', label: '설정', Icon: SlidersHorizontal }
]

interface AppShellProps {
  tab: Tab
  loginId: string
  /** Something to tell the user above the content (an error or a notice). */
  banner?: ReactNode
  /** The status column; it is hidden when the window is narrow. */
  side?: ReactNode
  signingOut: boolean
  onNavigate(tab: Tab): void
  onSignOut(): void
  onQuit(): void
  children: ReactNode
}

/** The signed-in window: a menu on the left, the chosen tab in the middle and, optionally, the status on the right. */
export function AppShell({
  tab,
  loginId,
  banner,
  side,
  signingOut,
  onNavigate,
  onSignOut,
  onQuit,
  children
}: AppShellProps) {
  return (
    <div className={`shell${side ? ' shell-with-side' : ''}`}>
      <nav className="rail" aria-label="주 메뉴">
        <div className="rail-brand">
          <div className="brand-mark" aria-hidden="true">
            J
          </div>
          <p className="brand-name">JARVIS</p>
        </div>
        <ul className="rail-nav">
          {TABS.map(({ tab: id, label, Icon }) => (
            <li key={id}>
              <button
                className="rail-item"
                type="button"
                aria-current={id === tab ? 'page' : undefined}
                aria-label={label}
                onClick={() => onNavigate(id)}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="rail-foot">
          <div className="rail-user">
            <span className="rail-avatar" aria-hidden="true">
              {loginId.slice(0, 1).toUpperCase()}
            </span>
            <span className="rail-user-text">
              <b>{loginId}</b>
              <small>로그인됨</small>
            </span>
          </div>
          <button
            className="rail-item"
            type="button"
            aria-label="로그아웃"
            disabled={signingOut}
            onClick={onSignOut}
          >
            <LogOut aria-hidden="true" />
            <span>로그아웃</span>
          </button>
          <button
            className="rail-item rail-quit"
            type="button"
            aria-label="앱 종료"
            onClick={onQuit}
          >
            <Power aria-hidden="true" />
            <span>앱 종료</span>
          </button>
        </div>
      </nav>
      <main className="shell-main">
        {banner}
        {children}
      </main>
      {side && (
        <aside className="shell-side" aria-label="현재 상태">
          {side}
        </aside>
      )}
    </div>
  )
}
