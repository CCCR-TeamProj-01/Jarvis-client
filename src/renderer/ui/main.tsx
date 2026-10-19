import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

function App(): React.JSX.Element {
  return (
    <main className="min-h-screen bg-slate-950 px-8 py-12 text-slate-100">
      <div className="mx-auto max-w-2xl">
        <p className="mb-3 text-sm font-medium tracking-widest text-sky-300">JARVIS CLIENT</p>
        <h1 className="text-4xl font-semibold">자비스</h1>
        <p className="mt-4 text-slate-300">
          Windows와 macOS를 위한 데스크톱 클라이언트 골격입니다.
        </p>
        <p className="mt-8 rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-400">
          현재 플랫폼: {window.jarvis.platform} · 음성, 제스처, 서버 연결 기능은 아직 구현되지
          않았습니다.
        </p>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
