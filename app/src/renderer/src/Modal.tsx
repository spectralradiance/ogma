import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'

interface ModalProps {
  /** Names the dialog for screen readers; the visible heading stays in the content. */
  label: string
  onClose: () => void
  /** Sizing and layout classes for the dialog panel. */
  className?: string
  children: ReactNode
}

/** A modal dialog: focus is trapped, Escape and clicks outside close it, and focus returns afterwards. */
export function Modal({ label, onClose, className = '', children }: ModalProps) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop">
          <Dialog.Content className={`modal ${className}`} aria-describedby={undefined}>
            <Dialog.Title className="sr-only">{label}</Dialog.Title>
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
