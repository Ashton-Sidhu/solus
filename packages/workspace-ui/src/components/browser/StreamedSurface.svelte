<script lang="ts">
  import type {
    BrowserInteractOp,
    BrowserPage,
  } from "@solus/contracts/browser-types";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import BrowserSkeleton from "./BrowserSkeleton.svelte";
  import { FramePainter } from "./lib/frame-painter";
  import {
    isPrintableKey,
    keepsStrokePoint,
    pointToViewport,
    rectFromDrag,
    RegionBrowserSender,
    type ViewportPoint,
  } from "./lib/streamed-input";

  /**
   * The streamed browser surface: a canvas painting JPEG frames the host sends.
   *
   * This is what a client with no native `<webview>` — web, mobile — sees, and
   * how any client will see a device target. It subscribes to frames only while
   * its pane is visible, so a hidden pane streams nothing; the host produces
   * frames only for subscribed clients, so "hidden panes cost nothing" holds end
   * to end. Pointer and key input are mapped from the canvas to the guest's own
   * viewport and forwarded — the light interaction a streamed surface allows,
   * short of the desktop's full-fidelity native path.
   */

  interface Props {
    pageKey: string;
    page: BrowserPage;
    /** False while the pane is mounted but hidden. A hidden surface unsubscribes
     *  so no frames cross the wire for a page no one is looking at. */
    active: boolean;
  }

  let { pageKey, page, active }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  /** The focusable, keyboard-driven wrapper around the canvas. */
  let surface = $state<HTMLDivElement | null>(null);
  let textBridge = $state<HTMLInputElement | null>(null);
  let hasFrame = $state(false);
  let streamError = $state<string | null>(null);

  // One subscription per (canvas, page, visible). The painter belongs to the
  // canvas; the subscription to the host. Tearing both down together is what
  // makes a parked pane free.
  $effect(() => {
    const node = canvas;
    if (!node || !active) return;
    const painter = new FramePainter(node);
    streamError = null;
    const cachedFrame = browserStore.cachedFrame(pageKey);
    hasFrame = cachedFrame !== null;
    if (cachedFrame) void painter.restore(cachedFrame.data);
    const stop = browserStore.subscribeFrames(
      pageKey,
      (header, data) => {
        hasFrame = true;
        void painter.paint(header.seq, data);
      },
      (error) => {
        streamError = error.message;
      },
    );
    return () => {
      stop();
      painter.dispose();
    };
  });

  function send(op: BrowserInteractOp) {
    void browserStore.interact(pageKey, op).catch(() => {});
  }

  function viewportPoint(event: MouseEvent): { x: number; y: number } | null {
    if (!canvas) return null;
    return pointToViewport(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      page.viewport,
    );
  }

  /**
   * Marking a streamed page.
   *
   * The desktop `<webview>` is drawn on directly — the overlay injected into the
   * guest sees the pointer itself. A canvas cannot be: it is a picture of the
   * page, so a drag exists only here. The gesture is tracked and inked locally
   * at frame rate. Box browsers use a latest-wins remote lane so the guest can
   * outline the DOM elements currently included without queuing every pointer
   * event; freehand still crosses only once, as one mark on release. The mark
   * lands in the guest either way, which keeps it inside captures and prompts.
   *
   * `pick` and `erase` need none of this: they are a single point, and the
   * `clickAt` the surface already sends reaches the overlay as a real press.
   */
  const dragTool = $derived(
    page.annotationTool === "draw" ||
      page.annotationTool === "region"
      ? page.annotationTool
      : null,
  );
  let strokePoints = $state<ViewportPoint[]>([]);
  // The two ends of the box selection.
  let dragFrom = $state<ViewportPoint | null>(null);
  let dragTo = $state<ViewportPoint | null>(null);
  let regionBrowserSender: RegionBrowserSender | null = null;

  // Remote clients need the guest to state which DOM elements the current box
  // includes. Browser updates share one latest-wins lane, so latency can drop
  // intermediate rectangles but can never let an old one overtake the commit.
  $effect(() => {
    const key = pageKey;
    const sender = new RegionBrowserSender(async (update) => {
      if (update.commit && update.rect) {
        await browserStore.annotate(key, {
          kind: "browserRegion",
          rect: update.rect,
          commit: true,
        });
      } else {
        await browserStore.browserAnnotationRegion(key, update.rect);
      }
    });
    regionBrowserSender = sender;
    return () => {
      void sender.clear();
      if (regionBrowserSender === sender) regionBrowserSender = null;
    };
  });

  /** The ink is plotted in the guest's own coordinates and let the `viewBox` do
   *  the scaling — the canvas already shows that viewport stretched to its own
   *  size, so the same mapping drawn twice is a second answer waiting to
   *  disagree with the mark that gets committed. */
  const inkPath = $derived(
    strokePoints.length > 1
      ? strokePoints.map((point) => `${point.x},${point.y}`).join(" ")
      : "",
  );
  const inkRect = $derived(
    dragTool === "region" && dragFrom && dragTo
      ? rectFromDrag(dragFrom, dragTo)
      : null,
  );
  function endGesture() {
    const path = strokePoints;
    const rect = inkRect;
    strokePoints = [];
    dragFrom = null;
    dragTo = null;
    if (path.length > 1) {
      void browserStore
        .annotate(pageKey, { kind: "mark", tool: "draw", path })
        .catch(() => {});
      return;
    }
    // A press that never moved is not a rectangle. Dropping it here is the same
    // rule the guest's own pointer path applies, so a mistimed tap does not
    // become an invisible entry in the prompt on one client and nothing on the
    // other.
    if (rect && rect.width > 4 && rect.height > 4) {
      void regionBrowserSender?.commit(rect);
    } else {
      void regionBrowserSender?.clear();
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (!dragTool) return;
    const point = viewportPoint(event);
    if (!point) return;
    event.preventDefault();
    // The canvas keeps the gesture even when the pointer crosses the pane edge,
    // so a stroke that runs off the page still ends where the user let go.
    if (event.currentTarget instanceof Element) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (dragTool === "draw") strokePoints = [point];
    else {
      void regionBrowserSender?.clear();
      dragFrom = point;
      dragTo = point;
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragTool) return;
    const point = viewportPoint(event);
    if (!point) return;
    if (dragTool === "draw") {
      const last = strokePoints[strokePoints.length - 1];
      if (!last || !keepsStrokePoint(last, point)) return;
      strokePoints.push(point);
      return;
    }
    if (dragFrom) {
      dragTo = point;
      const rect = rectFromDrag(dragFrom, point);
      if (rect.width > 4 && rect.height > 4) {
        void regionBrowserSender?.browser(rect);
      }
    }
  }

  function onPointerUp() {
    if (!dragTool) return;
    endGesture();
  }

  function onClick(event: MouseEvent) {
    // A drag tool owns the pointer outright: forwarding the click that follows
    // its release would press whatever the user just circled.
    if (dragTool) return;
    const point = viewportPoint(event);
    if (!point) return;
    surface?.focus();
    // The surface can receive a hardware keyboard, but it cannot open a phone's
    // soft keyboard. Focus a real input in the same tap gesture on touch-first
    // clients, then forward its input below.
    if (window.matchMedia("(pointer: coarse)").matches) {
      textBridge?.focus({ preventScroll: true });
    }
    send({ kind: "clickAt", x: point.x, y: point.y });
  }

  function onWheel(event: WheelEvent) {
    const point = viewportPoint(event);
    if (!point) return;
    event.preventDefault();
    send({ kind: "scrollAt", x: point.x, y: point.y, deltaY: event.deltaY });
  }

  /**
   * Touch panning.
   *
   * A phone has no wheel, and the canvas takes `touch-none` so the browser will
   * not scroll the pane instead — which left a streamed page unscrollable on the
   * one client that most needs it. A drag is turned into the wheel deltas the
   * guest already understands, so nothing new reaches the driver.
   *
   * A tap still becomes a click: the browser synthesizes one after a touch that
   * did not move, and this never calls `preventDefault` on the start.
   */
  let panFrom: { x: number; y: number } | null = null;

  function onTouchStart(event: TouchEvent) {
    // A finger that is drawing is not a finger that is scrolling.
    if (dragTool) return;
    const touch = event.touches[0];
    panFrom = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function onTouchMove(event: TouchEvent) {
    const touch = event.touches[0];
    if (dragTool || !panFrom || !touch || !canvas) return;
    const deltaY = panFrom.y - touch.clientY;
    // A finger reports far more often than a scroll needs, and every frame is a
    // round trip to the host.
    if (Math.abs(deltaY) < 4) return;
    const point = pointToViewport(
      touch.clientX,
      touch.clientY,
      canvas.getBoundingClientRect(),
      page.viewport,
    );
    panFrom = { x: touch.clientX, y: touch.clientY };
    if (point) send({ kind: "scrollAt", x: point.x, y: point.y, deltaY });
  }

  function onKeydown(event: KeyboardEvent) {
    // Leave the desktop client's own shortcuts to it: a streamed keyboard is for
    // typing into the page, not for hijacking the app's command chords.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (isPrintableKey(event.key)) send({ kind: "insertText", text: event.key });
    else send({ kind: "press", key: event.key });
  }

  function onTextInput(event: Event) {
    if (!(event.currentTarget instanceof HTMLInputElement)) return;
    const input = event.currentTarget;
    if (input.value) send({ kind: "insertText", text: input.value });
    input.value = "";
  }

  function onTextKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Printable text arrives through `input`, including composition and mobile
    // keyboard substitutions. Only named keys use the key path.
    if (isPrintableKey(event.key) || event.key === "Process") return;
    event.preventDefault();
    send({ kind: "press", key: event.key });
  }
</script>

<div class="absolute inset-0">
  <!-- role="application" belongs on the wrapper, not on the canvas: the canvas
       is the paint target and ARIA gives it no interactive role to take. The
       wrapper is the live view — driven by the pointer and keyboard handlers
       rather than being a static image — and shares the canvas box exactly, so
       the rects the handlers read off the canvas still line up.

       The two ignores below are the compiler's role table, not a real defect:
       aria-query types `application` as a window rather than a widget, so
       Svelte reads it as non-interactive. `application` is precisely the role
       for a surface that takes the keyboard itself, which is what this is —
       every key goes to the guest page rather than to the client. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={surface}
    tabindex="0"
    role="application"
    aria-label="Live browser of {page.label}"
    class="h-full w-full touch-none outline-none {dragTool
      ? 'cursor-crosshair'
      : ''}"
    onclick={onClick}
    onwheel={onWheel}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    ontouchstart={onTouchStart}
    ontouchmove={onTouchMove}
    ontouchend={() => (panFrom = null)}
    onkeydown={onKeydown}
  >
    <canvas bind:this={canvas} class="block h-full w-full"></canvas>
  </div>

  <input
    bind:this={textBridge}
    class="pointer-events-none absolute bottom-0 left-1/2 size-px opacity-0"
    type="text"
    inputmode="text"
    autocomplete="off"
    autocapitalize="sentences"
    spellcheck="true"
    tabindex="-1"
    aria-label="Type into the live browser"
    oninput={onTextInput}
    onkeydown={onTextKeydown}
  />

  <!-- The gesture in progress, drawn here rather than waited for. The committed
       mark comes back from the guest on the next read and this ink disappears
       under it; what it buys is a stroke that follows the finger at frame rate
       instead of at the speed of the network. -->
  {#if inkPath || inkRect}
    <svg
      class="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 {page.viewport.width} {page.viewport.height}"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {#if inkPath}
        <polyline
          points={inkPath}
          fill="none"
          stroke="var(--primary)"
          stroke-width="3"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      {:else if inkRect}
        <rect
          x={inkRect.x}
          y={inkRect.y}
          width={Math.max(1, inkRect.width)}
          height={Math.max(1, inkRect.height)}
          fill="color-mix(in oklch, var(--primary) 14%, transparent)"
          stroke="var(--primary)"
          stroke-width="1.5"
          stroke-dasharray="4 3"
          vector-effect="non-scaling-stroke"
        />
      {/if}
    </svg>
  {/if}

  {#if streamError}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md bg-(--solus-container-bg) px-6 text-center"
    >
      <p class="text-workspace-chrome text-(--solus-text-primary)">
        This browser can't be streamed here.
      </p>
      <p class="text-workspace-chrome text-(--solus-text-tertiary)">
        {streamError}
      </p>
    </div>
  {:else if !hasFrame}
    <!-- The same wait the desktop guest shows, in the same shape: a streamed
         page has nothing to paint until the first frame lands. -->
    <BrowserSkeleton label={page.label} />
  {/if}
</div>
