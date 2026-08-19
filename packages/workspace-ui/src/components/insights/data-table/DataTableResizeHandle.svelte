<script lang="ts">
  // The grab area on a column's trailing edge. It is a button rather than a
  // bare span because a column width is a control like any other: the keyboard
  // nudges it with the arrow keys and returns it to its default with Enter,
  // which is also what a double-click does for the pointer.

  let {
    columnLabel,
    active,
    onStart,
    onNudge,
    onReset,
  }: {
    columnLabel: string
    active: boolean
    /** `renderedWidthPx` is the column's width on screen, which is not the
     *  width the table holds for a column that absorbs the row's leftover
     *  space. Starting the drag anywhere else makes the column snap. */
    onStart: (event: MouseEvent | TouchEvent, renderedWidthPx: number) => void
    onNudge: (deltaPx: number) => void
    onReset: () => void
  } = $props()

  const STEP_PX = 16

  function start(event: MouseEvent | TouchEvent): void {
    const grip = event.currentTarget instanceof Element ? event.currentTarget : null
    const width = grip?.closest('th')?.getBoundingClientRect().width ?? 0
    onStart(event, width)
  }

  function nudge(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') onNudge(-STEP_PX)
    else if (event.key === 'ArrowRight') onNudge(STEP_PX)
    else if (event.key === 'Enter' || event.key === ' ') onReset()
    else return
    event.preventDefault()
    event.stopPropagation()
  }
</script>

<button
  type="button"
  class="absolute inset-y-0 right-0 z-20 flex w-3 translate-x-1/2 cursor-col-resize touch-none items-center justify-center rounded-full outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
  aria-label="Resize {columnLabel} column"
  onmousedown={start}
  ontouchstart={start}
  ondblclick={onReset}
  onkeydown={nudge}
  onclick={(event) => event.stopPropagation()}
>
  <span
    class="w-px rounded-full transition-[background-color,height] duration-150 motion-reduce:transition-none {active
      ? 'h-full bg-(--primary)'
      : 'h-4 bg-transparent group-hover/head:bg-[var(--hairline-strongest)]'}"
  ></span>
</button>
