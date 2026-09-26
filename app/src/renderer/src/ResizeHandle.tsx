import type { PointerEvent as ReactPointerEvent } from 'react'

interface ResizeHandleProps {
  /** The pane edge the handle sits on: the left pane's right edge, or the right pane's left edge. */
  edge: 'right' | 'left'
  width: number
  min: number
  max: number
  onResize: (width: number) => void
  onReset: () => void
}

/** A thin strip on a pane's inner edge: drag to resize the pane, double-click to reset it. */
export function ResizeHandle({ edge, width, min, max, onResize, onReset }: ResizeHandleProps) {
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add('resizing')
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      onResize(Math.round(Math.min(max, Math.max(min, edge === 'right' ? width + delta : width - delta))))
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      document.body.classList.remove('resizing')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  return (
    <div
      className={`pane-resize pane-resize-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={start}
      onDoubleClick={onReset}
      title="Drag to resize; double-click to reset"
    />
  )
}
