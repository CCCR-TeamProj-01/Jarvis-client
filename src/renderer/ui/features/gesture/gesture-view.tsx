import { Hand, MousePointer2, Square } from 'lucide-react'
import type { GestureSnapshot } from '../../../../shared/contracts/gesture'
import type { PermissionLine, Tone } from '../../view-model'
import { Keys, StatusChip } from '../shell/status-chip'

function describe(phase: GestureSnapshot['phase'], pointing: boolean, paused: boolean) {
  if (paused && phase === 'off')
    return {
      title: '인식이 일시 중지되어 있어요',
      detail: '인식을 다시 켜면 제스처를 시작할 수 있어요.',
      tone: 'idle' as Tone,
      chip: '일시 중지'
    }
  switch (phase) {
    case 'off':
      return {
        title: '제스처 제어가 꺼져 있어요',
        detail: '시작하면 카메라로 손을 인식해 커서를 움직여요. 영상은 이 기기에서만 처리돼요.',
        tone: 'idle' as Tone,
        chip: '꺼짐'
      }
    case 'lost':
      return {
        title: '손을 찾고 있어요',
        detail: '카메라에 손을 보여 주세요.',
        tone: 'info' as Tone,
        chip: '손을 찾는 중'
      }
    case 'suspended':
      return {
        title: '제스처 제어가 잠시 멈춰 있어요',
        detail: '곧 다시 이어져요.',
        tone: 'idle' as Tone,
        chip: '잠시 멈춤'
      }
    case 'tracking':
      return pointing
        ? {
            title: '손으로 제어하고 있어요',
            detail: '검지로 가리키면 커서가 따라오고, 엄지와 검지를 모으면 클릭해요.',
            tone: 'ok' as Tone,
            chip: '포인팅 인식 중'
          }
        : {
            title: '손은 보이지만 커서는 멈춰 있어요',
            detail: '검지만 펴고 가리키면 커서가 움직여요.',
            tone: 'ok' as Tone,
            chip: '커서 멈춤'
          }
  }
}

const STEPS = [
  { Icon: MousePointer2, title: '1. 가리키기', body: '검지만 펴고 손을 움직이면 커서가 따라와요.' },
  {
    Icon: Hand,
    title: '2. 클릭',
    body: '가리킨 채로 엄지와 검지를 모으면 한 번 클릭해요.'
  },
  { Icon: Square, title: '3. 멈추기', body: '손을 펴거나 주먹을 쥐면 커서가 그 자리에 멈춰요.' }
]

interface GestureViewProps {
  gesture: GestureSnapshot
  paused: boolean
  camera: PermissionLine | undefined
  toggleKeys: string[]
  onStart(): void
  onStop(): void
}

/** Gesture control: what it is doing, how to start and stop it, and how to use it. */
export function GestureView({
  gesture,
  paused,
  camera,
  toggleKeys,
  onStart,
  onStop
}: GestureViewProps) {
  const state = describe(gesture.phase, gesture.pointing, paused)
  const running = gesture.phase !== 'off'
  return (
    <section className="view" aria-labelledby="gesture-title">
      <header className="view-head">
        <h1 id="gesture-title">제스처</h1>
        <StatusChip tone={state.tone}>{state.chip}</StatusChip>
      </header>

      <div className="hero">
        <span className="hero-orb" aria-hidden="true" />
        <div className="hero-text">
          <h2>{state.title}</h2>
          <p>{state.detail}</p>
        </div>
        {running ? (
          <button className="button button-stop" type="button" onClick={onStop}>
            <Square aria-hidden="true" />
            중지 <Keys keys={toggleKeys} label="제스처 단축키" />
          </button>
        ) : (
          <button className="button button-start" type="button" disabled={paused} onClick={onStart}>
            <Hand aria-hidden="true" />
            시작 <Keys keys={toggleKeys} label="제스처 단축키" />
          </button>
        )}
      </div>

      <h2 className="section-title">사용 방법</h2>
      <ol className="steps">
        {STEPS.map(({ Icon, title, body }) => (
          <li className="step" key={title}>
            <span className="step-icon" aria-hidden="true">
              <Icon />
            </span>
            <b>{title}</b>
            <p>{body}</p>
          </li>
        ))}
      </ol>

      <h2 className="section-title">필요한 권한</h2>
      <ul className="rows">
        <li className="row">
          <span>카메라</span>
          {camera ? <StatusChip tone={camera.tone}>{camera.value}</StatusChip> : null}
        </li>
        <li className="row row-note">
          <span>
            손쉬운 사용
            <small>
              macOS에서 커서를 움직이려면 시스템 설정 &gt; 개인정보 보호 및 보안 &gt; 손쉬운
              사용에서 자비스를 허용해 주세요. 허용한 뒤 다시 시작하세요.
            </small>
          </span>
        </li>
      </ul>
      {camera?.hint && <p className="hint-block">{camera.hint}</p>}
    </section>
  )
}
