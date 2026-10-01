/** Accessible temporary panel; closing returns focus without changing story state. */
import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon.tsx'

/**
 * Show a modal with keyboard containment and an explicit close action.
 * @param props - Localized title, close action and panel content.
 * @returns The focus-contained temporary panel.
 */
export function Modal({
  title,
  closeLabel,
  onClose,
  children,
  wide = false,
}: {
  title: string
  closeLabel: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    return () => {
      prior?.focus()
    }
  }, [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={`modal-panel ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const controls = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
            ) ?? []),
          ]
          const first = controls[0],
            last = controls.at(-1)
          if (!first || !last) {
            event.preventDefault()
            return
          }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
