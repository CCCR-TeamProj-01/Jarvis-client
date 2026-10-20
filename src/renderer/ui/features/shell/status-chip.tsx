import type { Tone } from '../../view-model'

/** A small pill with a dot: the meaning is in the words, the colour only backs it up. */
export function StatusChip({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`chip chip-${tone}`}>{children}</span>
}

/** Keys of a shortcut, drawn one by one. */
export function Keys({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="keys" aria-label={label}>
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  )
}
