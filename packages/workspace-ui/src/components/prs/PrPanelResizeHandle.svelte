<script lang="ts">
  import { PR_PANEL_MIN_WIDTH } from "./lib/pr-panel-width";

  /** The panel's left edge as a drag handle: an 8px target centred
   *  on the seam, a hairline that shows on hover and tints while dragging.
   *  Arrow keys move it too, so the split is keyboard-adjustable. The width
   *  is reported live and committed once, when the drag or key press ends. */
  let { width, maxWidth, onResize, onCommit }: {
    width: number;
    maxWidth: number;
    onResize: (width: number) => void;
    onCommit: (width: number) => void;
  } = $props();

  let drag: { startX: number; startWidth: number } | null = null;

  function onPointerDown(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag = { startX: event.clientX, startWidth: width };
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag) return;
    // The handle is on the panel's left edge: moving left widens it.
    onResize(drag.startWidth + (drag.startX - event.clientX));
  }

  function onPointerUp() {
    if (!drag) return;
    drag = null;
    onCommit(width);
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (delta === 0) return;
    event.preventDefault();
    onResize(width + delta);
    onCommit(width + delta);
  }
</script>

<div
  class="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none select-none focus-visible:outline-none"
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize pull request panel"
  aria-valuenow={width}
  aria-valuemin={PR_PANEL_MIN_WIDTH}
  aria-valuemax={maxWidth}
  tabindex="0"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onkeydown={onKeyDown}
>
  <span
    class="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
    aria-hidden="true"
  ></span>
</div>
