import React, { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CircleAlert, CircleCheck, Info, LogOut, TriangleAlert } from 'lucide-react'
import { CheckingPanel, SignedInPanel, SignInForm, SignUpForm } from './features/auth/auth-panels'
import { useAuth } from './features/auth/use-auth'
import { ConversationPanel } from './features/conversation/conversation-panel'
import { GesturePanel } from './features/gesture/gesture-panel'
import { useClientSnapshot } from './use-client-snapshot'
import './styles.css'

function App(): React.JSX.Element {
  const { snapshot, error, messages, refresh, dispatch } = useClientSnapshot(window.jarvis)
  const auth = useAuth(window.jarvis?.auth)
  const [prefillLoginId, setPrefillLoginId] = useState('')
  const [signedUpNotice, setSignedUpNotice] = useState(false)
  const windowMaterial = snapshot?.application.windowMaterial ?? 'opaque'
  useLayoutEffect(() => {
    document.documentElement.dataset.windowMaterial = windowMaterial
    return () => {
      delete document.documentElement.dataset.windowMaterial
    }
  }, [windowMaterial])
  const phase = auth.snapshot?.phase ?? null
  const signup = snapshot?.screen === 'signup' && phase !== 'signed_in'
  const shortcut = snapshot?.application.shortcut
  const tray = snapshot?.application.tray
  const accelerator = shortcut?.accelerator
    .replace('CommandOrControl', window.jarvis?.platform === 'darwin' ? '⌘' : 'Ctrl')
    .replace('Shift', window.jarvis?.platform === 'darwin' ? '⇧' : 'Shift')
    .replaceAll('+', ' ')
  const checking = phase === 'checking'
  const showForms = phase === 'signed_out' || (checking && auth.restoreFailed)
  const heading = phase === 'signed_in' ? '자비스' : signup ? '계정 만들기' : '로그인'

  function openScreen(screen: 'login' | 'signup') {
    auth.clearMessages()
    setSignedUpNotice(false)
    void dispatch({ type: 'auth.open', screen })
  }

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
          <h1 id="account-heading">{heading}</h1>
          <p className="description">
            {phase === 'signed_in'
              ? '당신의 일상을 돕는 AI 어시스턴트'
              : signup
                ? '자비스와 함께할 계정을 만들어보세요.'
                : '당신의 일상을 돕는 AI 어시스턴트'}
          </p>
        </header>
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
        {phase === 'signed_in' && auth.snapshot?.user && (
          <SignedInPanel
            user={auth.snapshot.user}
            busy={auth.busy}
            error={auth.error}
            notice={auth.notice}
            onSignOut={() => {
              void auth.signOut()
            }}
          />
        )}
        {phase === 'signed_in' && snapshot && (
          <ConversationPanel
            phase={snapshot.speech.phase}
            conversationActive={snapshot.conversation.phase === 'active'}
            working={snapshot.request.phase === 'processing'}
            paused={snapshot.recognitionPaused}
            messages={messages}
            onStart={() => {
              void dispatch({ type: 'conversation.start' })
            }}
            onStop={() => {
              void dispatch({ type: 'conversation.stop' })
            }}
            onSubmitText={(text) => {
              void dispatch({ type: 'conversation.submit_text', text })
            }}
          />
        )}
        {phase === 'signed_in' && snapshot && (
          <GesturePanel
            phase={snapshot.gesture.phase}
            paused={snapshot.recognitionPaused}
            shortcut={window.jarvis?.platform === 'darwin' ? '⌘ ⇧ G' : 'Ctrl Shift G'}
            onStart={() => {
              void dispatch({ type: 'gesture.start' })
            }}
            onStop={() => {
              void dispatch({ type: 'gesture.stop' })
            }}
          />
        )}
        {checking && (
          <CheckingPanel
            failed={auth.restoreFailed}
            busy={auth.busy}
            message={auth.notice}
            onRetry={() => {
              void auth.restore()
            }}
          />
        )}
        {showForms && (
          <nav className="account-tabs" aria-label="계정 메뉴">
            <button
              type="button"
              aria-pressed={!signup}
              disabled={!snapshot || auth.busy !== null}
              onClick={() => openScreen('login')}
            >
              로그인
            </button>
            <button
              type="button"
              aria-pressed={signup}
              disabled={!snapshot || auth.busy !== null}
              onClick={() => openScreen('signup')}
            >
              회원가입
            </button>
          </nav>
        )}
        {showForms && signedUpNotice && !signup && (
          <p className="notice" role="status">
            <CircleCheck aria-hidden="true" />
            가입이 완료됐어요. 로그인해 주세요.
          </p>
        )}
        {showForms && signup && (
          <SignUpForm
            key="signup"
            busy={auth.busy}
            error={auth.error}
            checkLoginId={auth.checkLoginId}
            onSubmit={auth.signUp}
            onSignedUp={(loginId) => {
              setPrefillLoginId(loginId)
              setSignedUpNotice(true)
              void dispatch({ type: 'auth.open', screen: 'login' })
            }}
          />
        )}
        {showForms && !signup && (
          <SignInForm
            key="signin"
            busy={auth.busy}
            error={auth.error}
            notice={checking ? null : auth.notice}
            initialLoginId={prefillLoginId}
            onSubmit={auth.signIn}
          />
        )}
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
