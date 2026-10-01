/** Temporary panel on the DeepSeek Harness Modal primitive; closing returns focus without changing story state. */
import type { ReactNode } from 'react'
import { Modal as BaseModal } from '@deepseek-ai/dsh-client-ui-primitives/src/Modal.tsx'

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
  return (
    <BaseModal
      open
      title={title}
      closeLabel={closeLabel}
      onClose={onClose}
      className={wide ? 'dialog-wide' : 'dialog'}
      contentClassName="dialog-scroll"
    >
      {children}
    </BaseModal>
  )
}
