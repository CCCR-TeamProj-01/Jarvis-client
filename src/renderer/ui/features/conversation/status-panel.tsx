import { Cloud, MousePointer2, Mic } from 'lucide-react'
import type { StatusLine } from '../../view-model'
import { StatusChip } from '../shell/status-chip'

const ICONS = { microphone: Mic, gesture: MousePointer2, server: Cloud } as const

/** What is running right now, at a glance, beside the conversation. */
export function StatusPanel({ lines }: { lines: StatusLine[] }) {
  return (
    <>
      <h2 className="side-title">지금 상태</h2>
      <ul className="side-list">
        {lines.map(({ id, label, value, tone }) => {
          const Icon = ICONS[id]
          return (
            <li className="side-card" key={id}>
              <span className={`side-icon side-icon-${tone}`} aria-hidden="true">
                <Icon />
              </span>
              <span className="side-text">
                <b>{label}</b>
                <StatusChip tone={tone}>{value}</StatusChip>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="side-tip">
        카메라 영상은 이 기기에서만 처리돼요. 말한 내용은 인식이 끝난 발화만 서버로 전송돼요.
      </p>
    </>
  )
}
