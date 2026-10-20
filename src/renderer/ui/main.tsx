import React from 'react'
import { createRoot } from 'react-dom/client'
import { useClientSnapshot } from './use-client-snapshot'
import './styles.css'

function App(): React.JSX.Element {
  const { snapshot, error, refresh, dispatch } = useClientSnapshot(window.jarvis)
  const signup = snapshot?.screen === 'signup'
  const shortcut = snapshot?.application.shortcut
  const tray = snapshot?.application.tray
  const accelerator = shortcut?.accelerator
    .replace('CommandOrControl', window.jarvis?.platform === 'darwin' ? '⌘' : 'Ctrl')
    .replaceAll('+', ' + ')

  return (
    <main className="app-shell">
      <section className="account-card" aria-labelledby="account-heading">
        <header className="account-header">
          <div className="brand-mark" aria-hidden="true">
            J
          </div>
          <p className="eyebrow">JARVIS</p>
          <h1 id="account-heading">{signup ? '계정 만들기' : '로그인'}</h1>
          <p className="description">자비스와 함께 시작하세요.</p>
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
            <p>{error}</p>
            <button
              type="button"
              onClick={() => {
                void refresh()
              }}
            >
              다시 연결
            </button>
          </div>
        )}
        {!snapshot && !error && (
          <p className="notice" role="status">
            앱을 준비하고 있어요.
          </p>
        )}
        <form
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
              <button type="button" className="secondary" disabled>
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
          <button className="primary" type="submit" disabled>
            {signup ? '회원가입' : '로그인'}
          </button>
          <p className="availability-note">로그인 서비스를 준비 중입니다.</p>
        </form>
        {shortcut?.status === 'unavailable' && (
          <p className="notice" role="status">
            {shortcut.error.message}
          </p>
        )}
        {tray?.status === 'unavailable' && (
          <p className="notice" role="status">
            트레이를 사용할 수 없어 창을 유지합니다. 앱 종료 버튼으로 종료할 수 있어요.
          </p>
        )}
        <footer className="account-footer">
          <span>
            {shortcut?.status === 'registered'
              ? `호출 단축키 ${accelerator}`
              : '트레이에서 다시 열 수 있어요.'}
          </span>
          <button
            type="button"
            onClick={() => {
              void dispatch({ type: 'app.quit' })
            }}
          >
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
