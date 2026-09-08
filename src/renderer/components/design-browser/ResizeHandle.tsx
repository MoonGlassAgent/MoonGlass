import { useRef } from 'react'

/** 垂直分栏拖拽手柄（调整左右宽度） */
export function ColumnResizeHandle({
  onDrag,
  label
}: {
  onDrag: (deltaX: number) => void
  label: string
}): React.JSX.Element {
  const dragging = useRef(false)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onMouseDown={(event) => {
        event.preventDefault()
        dragging.current = true
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        const move = (moveEvent: MouseEvent): void => {
          if (dragging.current) onDrag(moveEvent.movementX)
        }
        const up = (): void => {
          dragging.current = false
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }}
      className="group relative w-1 shrink-0 cursor-col-resize bg-zinc-300 hover:bg-blue-400 active:bg-blue-500"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
      <div className="absolute left-1/2 top-1/2 h-10 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-zinc-400 group-hover:bg-white" />
    </div>
  )
}

/** 水平分栏拖拽手柄（调整上下高度） */
export function RowResizeHandle({
  onDrag,
  label
}: {
  onDrag: (deltaY: number) => void
  label: string
}): React.JSX.Element {
  const dragging = useRef(false)
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      onMouseDown={(event) => {
        event.preventDefault()
        dragging.current = true
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
        const move = (moveEvent: MouseEvent): void => {
          if (dragging.current) onDrag(moveEvent.movementY)
        }
        const up = (): void => {
          dragging.current = false
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }}
      className="group relative h-1 shrink-0 cursor-row-resize bg-zinc-300 hover:bg-blue-400 active:bg-blue-500"
    >
      <div className="absolute -top-1 -bottom-1 inset-x-0" />
      <div className="absolute left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2 bg-zinc-400 group-hover:bg-white" />
    </div>
  )
}
