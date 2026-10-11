import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

export type MenuItem =
  | 'separator'
  | {
    label: string
    onClick: () => void
    disabled?: boolean
    /** Makes this a checkbox item, ticked when true. */
    checked?: boolean
    /** Muted text on the right, such as a status. */
    hint?: string
    title?: string
  }

const CONTENT = 'z-50 min-w-[190px] rounded-md border border-border bg-raised py-1 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.22)]'
const ITEM = 'flex cursor-default items-center gap-2 py-[5px] pr-3.5 pl-3.5 outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-selection'
const SEPARATOR = 'my-1 h-px bg-border'

/** Radix's two menu kinds share these parts, so the items render the same in both. */
type Parts = typeof ContextMenuPrimitive | typeof DropdownMenuPrimitive

function renderItems(parts: Parts, items: MenuItem[]): ReactNode {
  return items.map((item, index) => {
    if (item === 'separator') return <parts.Separator key={index} className={SEPARATOR} />
    const body = (
      <>
        <span className="w-3.5 flex-none" aria-hidden="true">{item.checked && <Check size={13} />}</span>
        <span className="flex-1">{item.label}</span>
        {item.hint && <span className="text-xs text-muted">{item.hint}</span>}
      </>
    )
    return item.checked === undefined ? (
      <parts.Item key={index} className={ITEM} disabled={item.disabled} title={item.title} onSelect={item.onClick}>
        <span className="w-0 flex-none" />
        <span className="flex-1">{item.label}</span>
        {item.hint && <span className="text-xs text-muted">{item.hint}</span>}
      </parts.Item>
    ) : (
      <parts.CheckboxItem key={index} className={ITEM} disabled={item.disabled} title={item.title} checked={item.checked} onSelect={item.onClick}>
        {body}
      </parts.CheckboxItem>
    )
  })
}

/** Right-click menu over `children`, which must be a single element that accepts a ref. */
export function ContextMenu({ items, children }: { items: MenuItem[]; children: ReactNode }) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        {/* Rename opens an input; letting focus return to the row would steal it. */}
        <ContextMenuPrimitive.Content className={CONTENT} onCloseAutoFocus={(event) => event.preventDefault()}>
          {renderItems(ContextMenuPrimitive, items)}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}

/** A menu opened from a button; `trigger` is that button. */
export function DropdownMenu({ items, trigger }: { items: MenuItem[]; trigger: ReactNode }) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content className={CONTENT} align="end" sideOffset={2} onCloseAutoFocus={(event) => event.preventDefault()}>
          {renderItems(DropdownMenuPrimitive, items)}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}
