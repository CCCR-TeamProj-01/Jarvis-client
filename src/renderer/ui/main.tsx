import React, { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowRight, CircleAlert, Info, LogOut, TriangleAlert } from 'lucide-react'
import { useClientSnapshot } from './use-client-snapshot'
import './styles.css'

function App(): React.JSX.Element {
  const { snapshot, error, refresh, dispatch } = useClientSnapshot(window.jarvis)
  const windowMaterial = snapshot?.application.windowMaterial ?? 'opaque'
  useLayoutEffect(() => {
    document.documentElement.dataset.windowMaterial = windowMaterial
    return () => {
      delete document.documentElement.dataset.windowMaterial
    }
  }, [windowMaterial])
  const signup = snapshot?.screen === 'signup'
  const shortcut = snapshot?.application.shortcut
  const tray = snapshot?.application.tray
  const accelerator = shortcut?.accelerator
    .replace('CommandOrControl', window.jarvis?.platform === 'darwin' ? '⌘' : 'Ctrl')
    .replace('Shift', window.jarvis?.platform === 'darwin' ? '⇧' : 'Shift')
    .replaceAll('+', ' ')

  return (
    <main className="app-shell">
      <section className="account-card" aria-labelledby="account-heading">
        <header className="account-header">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              J
            </div>
            <p className="brand-name">JARVIS</p>
          </div>
          <h1 id="account-heading">{signup ? '계정 만들기' : '로그인'}</h1>
          <p className="description">
            {signup ? '자비스와 함께할 계정을 만들어보세요.' : '당신의 일상을 돕는 AI 어시스턴트'}
          </p>
        </header>
        <nav className="account-tabs" aria-label="계정 메뉴">
          <button
            type="button"
            aria-pressed={!signup}
            disabled={!snapshot}
            onClick={() => {
              void dispatch({ type: 'auth.open', screen: 'login' })
            }}
          >
            로그인
          </button>
          <button
            type="button"
            aria-pressed={signup}
            disabled={!snapshot}
            onClick={() => {
              void dispatch({ type: 'auth.open', screen: 'signup' })
            }}
          >
            회원가입
          </button>
        </nav>
        {error && (
          <div className="notice notice-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <div>
              <p>{error}</p>
              <button
                className="button button-ghost"
                type="button"
                onClick={() => {
                  void refresh()
                }}
              >
                다시 연결
              </button>
            </div>
          </div>
        )}
        {!snapshot && !error && (
          <p className="notice" role="status">
            <Info aria-hidden="true" />
            앱을 준비하고 있어요.
          </p>
        )}
        <form
          className="account-form"
          aria-describedby="auth-availability"
          onSubmit={(event) => event.preventDefault()}
          aria-label={signup ? '회원가입 양식' : '로그인 양식'}
        >
          <label htmlFor="login-id">아이디</label>
          <div className="input-row">
            <input
              id="login-id"
              name="loginId"
              autoComplete="username"
              placeholder="아이디를 입력하세요"
              disabled
            />
            {signup && (
              <button type="button" className="button button-secondary" disabled>
                중복 확인
              </button>
            )}
          </div>
          <label htmlFor="password">비밀번호</label>
          <input
            id="password"
            type="password"
            name="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            placeholder="비밀번호를 입력하세요"
            disabled
          />
          {signup && (
            <>
              <label htmlFor="password-confirm">비밀번호 재입력</label>
              <input
                id="password-confirm"
                type="password"
                name="passwordConfirmation"
                autoComplete="new-password"
                placeholder="비밀번호를 다시 입력하세요"
                disabled
              />
            </>
          )}
          <button className="button button-primary" type="submit" disabled>
            {signup ? '회원가입' : '로그인'}
            <ArrowRight aria-hidden="true" />
          </button>
          <p className="availability-note" id="auth-availability">
            <Info aria-hidden="true" />
            로그인 기능 준비 중으로, 아직 입력할 수 없어요.
          </p>
        </form>
        {shortcut?.status === 'unavailable' && (
          <p className="notice notice-warning" role="status">
            <TriangleAlert aria-hidden="true" />
            {shortcut.error.message}
          </p>
        )}
        {tray?.status === 'unavailable' && (
          <p className="notice notice-warning" role="status">
            <TriangleAlert aria-hidden="true" />
            트레이를 사용할 수 없어 창을 유지합니다. 앱 종료 버튼으로 종료할 수 있어요.
          </p>
        )}
        <footer className="account-footer">
          <span className="shortcut-hint">
            {shortcut?.status === 'registered' ? (
              <>
                <span>호출</span>
                <kbd aria-label={`호출 단축키 ${shortcut.accelerator}`}>{accelerator}</kbd>
              </>
            ) : tray?.status === 'ready' ? (
              '트레이에서 다시 열 수 있어요.'
            ) : (
              '창에서 앱을 종료할 수 있어요.'
            )}
          </span>
          <button
            className="button button-ghost"
            type="button"
            onClick={() => {
              void dispatch({ type: 'app.quit' })
            }}
          >
            <LogOut aria-hidden="true" />
            앱 종료
          </button>
        </footer>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
