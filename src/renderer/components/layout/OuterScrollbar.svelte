<script lang="ts">
  interface Props {
    target: HTMLElement | null;
  }

  let { target }: Props = $props();

  let trackElement = $state<HTMLDivElement | null>(null);
  let thumbHeight = $state(0);
  let thumbTop = $state(0);
  let isScrollable = $state(false);
  let controlledElementId = $state("workspace-scroll-source");
  let scrollTop = $state(0);
  let scrollMax = $state(0);
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  function updateThumb() {
    if (!target || !trackElement) {
      isScrollable = false;
      return;
    }

    const scrollRange = target.scrollHeight - target.clientHeight;
    const trackHeight = trackElement.clientHeight;
    isScrollable = scrollRange > 1 && trackHeight > 0;
    scrollTop = target.scrollTop;
    scrollMax = Math.max(0, scrollRange);
    if (!isScrollable) return;

    thumbHeight = Math.max(
      28,
      (target.clientHeight / target.scrollHeight) * trackHeight,
    );
    const thumbRange = Math.max(0, trackHeight - thumbHeight);
    thumbTop = (target.scrollTop / scrollRange) * thumbRange;
  }

  $effect(() => {
    const scrollElement = target;
    const track = trackElement;
    if (!scrollElement || !track) return;

    const resizeObserver = new ResizeObserver(updateThumb);
    const previousId = scrollElement.id;
    const assignedId =
      previousId || `workspace-scroll-source-${crypto.randomUUID()}`;
    scrollElement.id = assignedId;
    controlledElementId = assignedId;
    resizeObserver.observe(scrollElement);
    resizeObserver.observe(track);
    for (const child of scrollElement.children) resizeObserver.observe(child);
    scrollElement.addEventListener("scroll", updateThumb, { passive: true });
    updateThumb();

    return () => {
      resizeObserver.disconnect();
      scrollElement.removeEventListener("scroll", updateThumb);
      if (!previousId && scrollElement.id === assignedId) {
        scrollElement.removeAttribute("id");
      }
    };
  });

  function setScrollFromPointer(clientY: number) {
    if (!target || !trackElement) return;
    const trackRect = trackElement.getBoundingClientRect();
    const thumbRange = trackRect.height - thumbHeight;
    const scrollRange = target.scrollHeight - target.clientHeight;
    if (thumbRange <= 0 || scrollRange <= 0) return;
    const nextThumbTop = Math.min(
      thumbRange,
      Math.max(0, clientY - trackRect.top - thumbHeight / 2),
    );
    target.scrollTop = (nextThumbTop / thumbRange) * scrollRange;
  }

  function handlePointerDown(event: PointerEvent) {
    if (!target || !trackElement || !isScrollable) return;
    const trackRect = trackElement.getBoundingClientRect();
    const pointerY = event.clientY - trackRect.top;
    if (pointerY < thumbTop || pointerY > thumbTop + thumbHeight) {
      setScrollFromPointer(event.clientY);
    }
    dragStartY = event.clientY;
    dragStartScrollTop = target.scrollTop;
    trackElement.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handlePointerMove(event: PointerEvent) {
    if (!target || !trackElement?.hasPointerCapture(event.pointerId)) return;
    const thumbRange = trackElement.clientHeight - thumbHeight;
    const scrollRange = target.scrollHeight - target.clientHeight;
    if (thumbRange <= 0 || scrollRange <= 0) return;
    target.scrollTop =
      dragStartScrollTop +
      (event.clientY - dragStartY) * (scrollRange / thumbRange);
  }

  function handlePointerUp(event: PointerEvent) {
    if (trackElement?.hasPointerCapture(event.pointerId)) {
      trackElement.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!target || !isScrollable) return;
    const pageStep = target.clientHeight * 0.9;
    const scrollAmount =
      event.key === "ArrowDown"
        ? 40
        : event.key === "ArrowUp"
          ? -40
          : event.key === "PageDown"
            ? pageStep
            : event.key === "PageUp"
              ? -pageStep
              : null;
    if (scrollAmount !== null) {
      target.scrollBy({ top: scrollAmount, behavior: "smooth" });
      event.preventDefault();
    } else if (event.key === "Home" || event.key === "End") {
      target.scrollTo({
        top: event.key === "Home" ? 0 : target.scrollHeight,
        behavior: "smooth",
      });
      event.preventDefault();
    }
  }
</script>

<div
  bind:this={trackElement}
  class="outer-scrollbar no-drag"
  class:outer-scrollbar--visible={isScrollable}
  role="scrollbar"
  aria-label="Page scrollbar"
  aria-controls={controlledElementId}
  aria-orientation="vertical"
  aria-valuemin="0"
  aria-valuemax={scrollMax}
  aria-valuenow={scrollTop}
  tabindex={isScrollable ? 0 : -1}
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={handlePointerUp}
  onkeydown={handleKeydown}
>
  <span
    class="outer-scrollbar__thumb"
    style:height="{thumbHeight}px"
    style:transform="translateY({thumbTop}px)"
  ></span>
</div>

<style>
  .outer-scrollbar {
    position: absolute;
    z-index: 100;
    top: 0.5rem;
    right: 0.1875rem;
    bottom: 0.5rem;
    width: 0.625rem;
    cursor: default;
    opacity: 0;
    pointer-events: none;
    transition: opacity 150ms ease;
  }

  .outer-scrollbar--visible {
    opacity: 1;
    pointer-events: auto;
  }

  .outer-scrollbar__thumb {
    position: absolute;
    top: 0;
    right: 0.0625rem;
    width: 0.125rem;
    border-radius: 999px;
    background: var(--solus-scroll-thumb);
    transition: background-color 150ms ease;
  }

  .outer-scrollbar:hover .outer-scrollbar__thumb {
    background: var(--solus-scroll-thumb-hover);
  }
</style>
