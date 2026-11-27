<script lang="ts">
  import { clampModalSize, hasTopHandles, measureModal, resizeModal, type ModalBox, type ModalEdge, type ModalSize } from "./modal-size";
  import type { ResizableModal } from "./modal-size.svelte";

  /** The resize handles of one modal card. Put them as the last children of the
   *  card, which must be positioned (`relative` or `fixed`). Every edge and
   *  corner drags, except the top ones of a modal pinned near the top. The
   *  bottom-right corner also takes focus, and the arrow keys resize from it
   *  (Shift for bigger steps). Home or a double-click on any
   *  handle goes back to the default size. A touch screen gets no handles. */
  let { modal, label }: {
    modal: ResizableModal;
    /** Names the modal for a screen reader: "Resize settings". */
    label: string;
  } = $props();

  let drag: { edge: ModalEdge; startX: number; startY: number; start: ModalSize; max: ModalSize; focused: Element | null } | null = null;

  /** The card is the handle's parent. */
  function cardBox(handle: HTMLElement): ModalBox {
    const card = (handle.parentElement ?? handle).getBoundingClientRect();
    return measureModal(card, { width: window.innerWidth, height: window.innerHeight }, modal.anchor);
  }

  function onPointerDown(edge: ModalEdge, event: PointerEvent & { currentTarget: HTMLElement }) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const box = cardBox(event.currentTarget);
    // The press can move focus to the card; the drag gives it back, so the
    // reader keeps typing where they were.
    drag = { edge, startX: event.clientX, startY: event.clientY, start: box.size, max: box.max, focused: document.activeElement };
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag) return;
    // No button is down: the release was lost, so the drag ends here.
    if (event.buttons === 0) {
      onPointerUp();
      return;
    }
    modal.resize(resizeModal(drag.start, { x: event.clientX - drag.startX, y: event.clientY - drag.startY }, drag.edge, modal.anchor, drag.max));
  }

  function onPointerUp() {
    if (!drag) return;
    const { focused } = drag;
    drag = null;
    modal.commit();
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) focused.focus();
  }

  function onKeyDown(event: KeyboardEvent & { currentTarget: HTMLElement }) {
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      modal.reset();
      return;
    }
    const step = event.shiftKey ? 64 : 16;
    const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
    if (dx === 0 && dy === 0) return;
    // The modal's own keys (a picker's arrow rows) must not also move.
    event.preventDefault();
    event.stopPropagation();
    const box = cardBox(event.currentTarget);
    modal.resize(clampModalSize({ width: box.size.width + dx, height: box.size.height + dy }, box.max));
    modal.commit();
  }

  function handlers(edge: ModalEdge) {
    return {
      onpointerdown: (event: PointerEvent & { currentTarget: HTMLElement }) => onPointerDown(edge, event),
      onpointermove: onPointerMove,
      onpointerup: onPointerUp,
      onpointercancel: onPointerUp,
      onlostpointercapture: onPointerUp,
      ondblclick: () => modal.reset(),
    };
  }
</script>

<!-- The edges are thin, so a scroller's thumb beside them stays grabbable; the
     corners are the main grips. -->
{#if hasTopHandles(modal.anchor)}
  <div
    class="group absolute inset-x-4 top-0 z-40 h-1 cursor-ns-resize touch-none select-none pointer-coarse:hidden"
    aria-hidden="true"
    {...handlers("top")}
  >
    <span class="pointer-events-none absolute inset-x-0 top-0 h-px bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"></span>
  </div>
  <div
    class="absolute top-0 left-0 z-40 size-4 cursor-nwse-resize touch-none select-none rounded-tl-[inherit] pointer-coarse:hidden"
    aria-hidden="true"
    {...handlers("top-left")}
  ></div>
  <div
    class="absolute top-0 right-0 z-40 size-4 cursor-nesw-resize touch-none select-none rounded-tr-[inherit] pointer-coarse:hidden"
    aria-hidden="true"
    {...handlers("top-right")}
  ></div>
{/if}
<div
  class="group absolute inset-y-4 left-0 z-40 w-[3px] cursor-ew-resize touch-none select-none pointer-coarse:hidden"
  aria-hidden="true"
  {...handlers("left")}
>
  <span class="pointer-events-none absolute inset-y-0 left-0 w-px bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"></span>
</div>
<div
  class="group absolute inset-y-4 right-0 z-40 w-[3px] cursor-ew-resize touch-none select-none pointer-coarse:hidden"
  aria-hidden="true"
  {...handlers("right")}
>
  <span class="pointer-events-none absolute inset-y-0 right-0 w-px bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"></span>
</div>
<div
  class="group absolute inset-x-4 bottom-0 z-40 h-1 cursor-ns-resize touch-none select-none pointer-coarse:hidden"
  aria-hidden="true"
  {...handlers("bottom")}
>
  <span class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"></span>
</div>
<div
  class="absolute bottom-0 left-0 z-40 size-4 cursor-nesw-resize touch-none select-none rounded-bl-[inherit] pointer-coarse:hidden"
  aria-hidden="true"
  {...handlers("bottom-left")}
></div>
<!-- The one corner the keyboard reaches. A focusable separator is the ARIA
     splitter pattern; Svelte counts every separator as static. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="absolute right-0 bottom-0 z-40 size-4 cursor-nwse-resize touch-none select-none rounded-br-[inherit] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--solus-accent-border) pointer-coarse:hidden"
  role="separator"
  aria-label={`${label}. Arrow keys resize, Home restores the default size.`}
  aria-valuetext={modal.size ? `${modal.size.width} by ${modal.size.height} pixels` : "Default size"}
  tabindex="0"
  onkeydown={onKeyDown}
  {...handlers("bottom-right")}
></div>
