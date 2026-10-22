import { useEffect, useRef } from 'react'

/**
 * A modal dialog the browser keeps focus inside. Escape closes it, unless something is being sent
 * (`locked`), when it stays open.
 */
export function useModal(onClose: () => void, locked: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal()
  }, [])
  return {
    ref,
    onCancel: (event: { preventDefault(): void }) => {
      event.preventDefault()
      if (!locked) onClose()
    }
  }
}
