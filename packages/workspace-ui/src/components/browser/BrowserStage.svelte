<script lang="ts">
  import type { Snippet } from "svelte";
  import type {
    BrowserPage,
    BrowserViewport,
    BrowserViewportRequest,
  } from "@solus/contracts/browser-types";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { Button } from "../ui/button";
  import StreamedSurface from "./StreamedSurface.svelte";
  import { addressParts } from "./lib/address";
  import {
    nativeSurfaces,
    type NativeSurfacePresentation,
    type NativeSurfaceRect,
  } from "./lib/native-surface-coordinator.svelte";
  import { browserOverlays } from "./lib/browser-overlays.svelte";
  import {
    shouldUseNativeBrowser,
    supportsNativeBrowser,
  } from "./lib/browser-guest";
  import { stageDrag } from "./lib/stage-drag.svelte";
  import {
    fillSize,
    fitStage,
    resizeViewport,
    stageRoom,
    type StageResizeEdge,
  } from "./lib/stage-math";

  /**
   * The letterboxed area a browser page is painted into.
   *
   * The stage itself draws no page — it reserves the space, states the
   * viewport, and publishes its rectangle so the app-root webview layer can
   * position the guest over it. When nothing can render the page, the stage is
   * where that is said, rather than leaving the user with a blank rectangle and
   * a browser error string.
   */

  interface Props {
    pageKey: string;
    serverId: string;
    page: BrowserPage;
    /** The annotation tools, when they are open. Floated over the page, the way
     *  every drawing tool puts its tools. Where they are *mounted* depends on
     *  what is rendering the page — see `overlay` below. Receives the frame's
     *  scale, so a mark-anchored control (the comment composer) can place itself
     *  in the frame's own coordinate space. */
    annotation?: Snippet<[number]>;
    /** While a mark's comment popup is open, the overlay owns the whole frame
     *  so hover and pointer input cannot leak into the page behind the popup. */
    annotationBlocksSurface?: boolean;
    /** Bumped once per capture. The frame answers with a shutter flash, which is
     *  the only feedback that says *this* page was the one photographed. */
    captureCount?: number;
    /** The size the user is steering, which leads the host's answer during a
     *  drag. Stated in the badge only — every measurement below stays on
     *  `page.viewport`, so the frame can never be a size the guest is not
     *  emulating. */
    statedViewport: BrowserViewport;
    /** False while the pane is mounted but hidden: a parked page must not claim
     *  a slot, or its guest would paint over whatever replaced the pane. */
    active: boolean;
    /** The native guest lives at app root. It needs to know when its stage is
     *  in the fixed maximized pane rather than the normal workspace. */
    maximized?: boolean;
    /** Sizes asked for from the stage itself: a filling page following the pane,
     *  and an edge the user dragged. */
    onViewport: (request: BrowserViewportRequest) => void;
    /** How much the device had to be shrunk to fit, 0–1. Only the stage can
     *  measure it, and the toolbar's size chip has to state it. */
    onScale: (scale: number) => void;
    /** Ask for the page again. The stage owns the only surface where a failed
     *  load is actually stated, so it has to carry the way out of it. */
    onReload: () => void;
  }

  let {
    pageKey,
    serverId,
    page,
    annotation,
    annotationBlocksSurface = false,
    captureCount = 0,
    statedViewport,
    active,
    maximized = false,
    onViewport,
    onScale,
    onReload,
  }: Props = $props();

  /** The shutter, keyed so a second capture restarts the animation rather than
   *  playing nothing because the element never changed. */
  const flashKey = $derived(captureCount);

  let host = $state<HTMLDivElement | null>(null);
  let availableWidth = $state(0);
  let availableHeight = $state(0);

  const fit = $derived(
    fitStage(page.viewport, availableWidth, availableHeight),
  );

  // Reported rather than derived by the chip: the measurement lives here, and a
  // second copy of this arithmetic is a second answer waiting to disagree.
  $effect(() => onScale(fit.scale));
  const nothingRenders = $derived(page.hostKind === "none");
  // Whether this client can host a native `<webview>` at all — a client fact,
  // not the host's.
  const canRenderHere = supportsNativeBrowser();
  // A native surface is the desktop `<webview>` teleported over this stage; it
  // only exists for url pages on a client that can host one. Everything else —
  // web, mobile, and every device target — is streamed onto a canvas, which
  // needs no teleport slot because a canvas moves and hides like any element.
  const usesNativeSurface = $derived(
    shouldUseNativeBrowser(
      canRenderHere,
      serverId,
      serverConnections.localServerId(),
      page.target.kind,
    ),
  );

  // The guest lives in a fixed layer at app root, so it needs viewport
  // coordinates, not the pane's. A pane drag, a window resize, and a scroll all
  // move the placeholder without any of them changing this component's props —
  // hence a measured read rather than a derived one.
  let presentation: NativeSurfacePresentation | null = null;

  function publishSlot() {
    const box = host?.getBoundingClientRect();
    // A box with no area is a stage that has not been measured, or a pane with
    // no room. The guest paints wherever this rectangle says, so an empty one
    // has to mean "nowhere" rather than "the top-left corner".
    if (!box || box.width < 1 || box.height < 1) {
      presentation?.park();
      return;
    }
    // Rounded, because this runs on every scroll and drag frame: a fractional
    // offset would republish an identical box and restyle the guest for nothing.
    const rect: NativeSurfaceRect = {
      left: Math.round(box.left),
      top: Math.round(box.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
      layer: maximized ? "maximized" : "workspace",
    };
    // Losing the claim means another stage now shows this page. Take it back:
    // this stage is measured and on screen, so it is the one the user is
    // looking at — and if the other stage is gone, nobody else will.
    if (presentation?.present(rect) === false) {
      presentation = nativeSurfaces.claimPresentation(pageKey);
      presentation.present(rect);
    }
  }

  // Listeners are bound to the element, not to the measurement: a pane drag
  // fires this many times a second, and rebuilding the observer on each frame
  // would cost more than the positioning it exists to do.
  $effect(() => {
    const node = host;
    if (!node || !active || !usesNativeSurface) {
      presentation?.release();
      presentation = null;
      return;
    }
    presentation = nativeSurfaces.claimPresentation(pageKey);
    publishSlot();

    const observer = new ResizeObserver(publishSlot);
    observer.observe(node);
    window.addEventListener("resize", publishSlot);
    // Capture phase: an ancestor pane scrolling moves the placeholder without
    // the event ever reaching the window in the bubble phase.
    window.addEventListener("scroll", publishSlot, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publishSlot);
      window.removeEventListener("scroll", publishSlot, true);
      presentation?.release();
      presentation = null;
    };
  });

  // A preset change resizes the placeholder through `fit`, which the observer
  // above does see — but the guest must be repositioned in the same frame the
  // box changes, not one layout pass later.
  $effect(() => {
    void fit.paintedWidth;
    void fit.paintedHeight;
    if (active && usesNativeSurface) publishSlot();
  });

  // A filling page is the size of the space it is shown in, so the stage is the
  // only side that knows what that is. The host coalesces these, which is what
  // keeps a pane drag from queueing an emulation call per frame.
  $effect(() => {
    if (page.viewport.mode !== "fill" || !active) return;
    const room = stageRoom(page.viewport, availableWidth, availableHeight);
    if (room.width < 1 || room.height < 1) return;
    const size = fillSize(room.width, room.height);
    if (size.width === page.viewport.width && size.height === page.viewport.height) return;
    onViewport({ mode: "fill", ...size });
  });

  /**
   * Drag an edge to size the page.
   *
   * Every frame is committed rather than approximated locally: the guest's viewport
   * is emulated by the host, so a stage that resized itself first would show the
   * old emulation stretched, which is exactly the lie the browser exists to
   * avoid. The window keeps the gesture even when the pointer crosses the guest,
   * because the layer stops taking pointer events while a drag is live.
   */
  function startResize(edge: StageResizeEdge, event: PointerEvent) {
    if (page.viewport.mode === "fill") return;
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY };
    const start = { width: page.viewport.width, height: page.viewport.height };
    const scale = fit.scale;
    const hasTouch = page.viewport.hasTouch;
    stageDrag.active = true;

    const move = (moveEvent: PointerEvent) => {
      const size = resizeViewport(
        start,
        { x: moveEvent.clientX - origin.x, y: moveEvent.clientY - origin.y },
        scale,
        edge,
      );
      onViewport({ mode: "custom", ...size, hasTouch });
    };
    const stop = () => {
      stageDrag.active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  /** The same resize from the keyboard, since a drag handle nobody can reach
   *  with a key is not a control in a keyboard-first workspace. */
  function nudge(edge: StageResizeEdge, event: KeyboardEvent) {
    const step = event.shiftKey ? 50 : 10;
    const delta = { x: 0, y: 0 };
    if (event.key === "ArrowRight") delta.x = step;
    else if (event.key === "ArrowLeft") delta.x = -step;
    else if (event.key === "ArrowDown") delta.y = step;
    else if (event.key === "ArrowUp") delta.y = -step;
    else return;
    event.preventDefault();
    // Halved: the drag maths doubles a centred edge's travel, and a key press is
    // asking for the step it names, not twice it.
    //
    // Stepped from the size being asked for, not the one confirmed: a held arrow
    // key repeats faster than the host answers, and counting from the stale size
    // would drop every step that lands mid-flight.
    const size = resizeViewport(
      { width: statedViewport.width, height: statedViewport.height },
      { x: delta.x / 2, y: delta.y / 2 },
      1,
      edge,
    );
    onViewport({ mode: "custom", ...size, hasTouch: statedViewport.hasTouch });
  }

  /**
   * Where the annotation pill is mounted.
   *
   * A native guest is a `<webview>` in a fixed layer at app root: it paints over
   * this pane whatever z-index the stage claims, and the pane cannot escape
   * upward because `WorkspaceBody` transforms its columns while they animate. So
   * the pill is handed to that layer, which renders it beside the guest — which
   * paints over it, because a `<webview>` is ordinary DOM. A streamed canvas is
   * an element in this component, so the stage floats the pill itself.
   */
  $effect(() => {
    const pill = annotation;
    if (!pill || !usesNativeSurface) return;
    browserOverlays.set(pageKey, pill, annotationBlocksSurface);
    return () => browserOverlays.clear(pageKey, pill);
  });

  const resizable = $derived(
    page.viewport.mode !== "fill" && fit.scale > 0 && !nothingRenders,
  );

  // A dead port is a state, not an error page. The code names it the way a
  // browser would so it is searchable; the headline says it in words.
  const problemCode = $derived(
    page.problem?.kind === "target-unreachable"
      ? "ERR_CONNECTION_REFUSED"
      : page.problem?.kind === "surface-crashed"
        ? "ERR_RENDERER_GONE"
        : "ERR_LOAD_FAILED",
  );
  const problemHeadline = $derived(
    page.problem?.kind === "target-unreachable"
      ? `${addressParts(page.url).host} isn't responding`
      : page.problem?.kind === "surface-crashed"
        ? "This browser page stopped responding"
        : "This page failed to load",
  );
  /** Which worktree serves the port. The branch, not the port, is what the user
   *  is actually working on — and two worktrees differ only by port. */
  const branchLabel = $derived(
    page.target.kind === "url" ? (page.target.branch ?? "") : "",
  );
</script>

<div
  class="text-workspace-chrome browser-canvas @container/stage relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--wash-1)] shadow-[inset_0_1px_0_var(--hairline)]"
>
    <!-- The page floats on a dot grid so its own edges stay visible even when the
         site's background is the same colour as the app's. -->
    <div class="browser-canvas__grid pointer-events-none absolute inset-0"></div>

  <!-- The measured area. Annotation details attach to the active composer, so
       the browser keeps the full canvas instead of reserving a comment rail. -->
  <div
    class="relative flex min-h-0 flex-1 items-center justify-center {page
      .viewport.mode !== 'fill'
      ? 'p-[1.625rem]'
      : ''}"
    bind:clientWidth={availableWidth}
    bind:clientHeight={availableHeight}
  >
    <!-- The frame is the subject: the only thing in the pane with a real shadow,
         and the only raised surface below the toolbar. -->
    <div
      bind:this={host}
      class="relative rounded-xl bg-[var(--card)] shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0.125rem_0.25rem_-0.125rem_rgba(0,0,0,0.16),0_1.625rem_3.75rem_-1.625rem_rgba(0,0,0,0.45)]"
      style:width="{fit.paintedWidth}px"
      style:height="{fit.paintedHeight}px"
    >
    <!-- DevTools hold the session everything else needs, so a streamed surface
         goes still and every command refuses while they are open. Saying so is
         the difference between a frozen picture and a stated trade. Native
         surfaces keep painting on their own, so they need no notice. -->
    {#if page.devToolsOpen && !usesNativeSurface}
      <div
        class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-(--solus-container-bg)/95 px-6 text-center"
      >
        <p class="text-(--solus-text-primary)">
          DevTools are open on this page.
        </p>
        <p class="text-(--solus-text-tertiary)">
          Chromium allows one inspector at a time, so Solus cannot stream or
          drive the page until the DevTools window is closed.
        </p>
      </div>
    {/if}

    <!-- No native `<webview>` here (web, mobile, or a device target): the page
         is streamed onto a canvas. Frames arrive over the binary side-channel,
         and the host hosts the page on demand when this surface subscribes, so a
         page no desktop pane is showing streams the same way a watched one does.
         Its own connecting and can't-stream states live inside it. -->
    {#if !usesNativeSurface}
      <StreamedSurface {pageKey} {page} {active} />
    {/if}

    <!-- A native page waiting for its `<webview>` is waiting, not broken. This
         copy is the native surface's alone: a streamed surface hosts the page
         itself the moment it subscribes, so "waiting for a pane" never applies. -->
    {#if usesNativeSurface && page.problem?.kind === "no-surface"}
      <div
        class="flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl px-6 text-center"
      >
        <p class="text-(--solus-text-secondary)">
          Nothing here is rendering this page yet.
        </p>
        <p class="text-(--solus-text-tertiary)">
          {page.problem.message}
        </p>
      </div>
    {:else if page.problem && page.problem.kind !== "no-surface"}
      <!-- Never a browser error page. A dead port is a fact about a process
           Solus does not own, so the card names the state, the branch whose
           worktree serves it, and the one action that is actually the user's. -->
      <div
        class="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-(--solus-container-bg)/95 p-8"
      >
        <div class="flex w-full max-w-[26rem] flex-col items-start gap-3">
          <span
            class="rounded-full bg-[color-mix(in_oklch,var(--failure)_14%,transparent)] px-2 py-0.5 font-medium text-[color:color-mix(in_oklch,var(--failure)_72%,var(--foreground))]"
          >
            {problemCode}
          </span>
          <div>
            <p
              class="font-semibold text-[length:calc(var(--text-workspace-chrome)+0.25rem)] text-(--solus-text-primary)"
            >
              {problemHeadline}
            </p>
            <p
              class="mt-1.5 leading-relaxed text-(--solus-text-tertiary)"
            >
              {page.problem.message}
            </p>
          </div>
          {#if branchLabel}
            <span
              class="w-full truncate rounded-lg bg-[var(--wash-2)] px-3 py-2 text-(--solus-text-secondary) shadow-[shadow:inset_0_0_0_0.5px_var(--hairline-strong)]"
            >
              Served from {branchLabel}
            </span>
          {/if}
          <div class="flex items-center gap-2">
            <!-- The way back from a guest Solus gave up on restarting. Bounded
                 automatic retries cannot loop on a page that crashes on load;
                 asking for one more is the user's call. Native-only: a crashed
                 guest is a `<webview>` concept. -->
            {#if page.problem.kind === "surface-crashed" && usesNativeSurface}
              <Button size="sm" onclick={() => nativeSurfaces.reload(pageKey)}>
                Reload browser
              </Button>
            {/if}
            {#if page.problem.kind !== "surface-crashed"}
              <!-- The page retries itself when the port answers, but a user who
                   has just started the server should not have to wait out a
                   poll to find out. -->
              <Button size="sm" onclick={onReload}>Retry</Button>
            {/if}
            {#if page.problem.kind === "target-unreachable"}
              <span class="text-(--solus-text-tertiary)">
                Solus does not run this server, so the page reloads itself once
                the port answers again.
              </span>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- The shutter. Keyed on the capture count so a second capture replays it,
         and rendered inside the frame so it says which page was photographed. -->
    {#key flashKey}
      {#if captureCount > 0}
        <div
          class="browser-flash pointer-events-none absolute inset-0 z-30 rounded-xl bg-white"
        ></div>
        <div
          class="browser-flash pointer-events-none absolute inset-1.5 z-30 rounded-lg shadow-[shadow:0_0_0_2px_var(--primary)]"
        ></div>
      {/if}
    {/key}

    <!-- Outside the frame on purpose: the guest is painted over the frame by the
         app-root layer, so a handle inside it would be under a `<webview>` and
         unclickable. The stage's own padding is the room they live in. -->
    {#if resizable}
      <!-- Capsules on the frame's own edges. They live in the letterbox,
           outside the frame, because the guest is painted over the frame by the
           app-root layer. -->
      <button
        type="button"
        class="absolute z-20 rounded-full bg-[var(--hairline-strongest)] transition-colors hover:bg-[var(--primary)] focus-visible:bg-[var(--primary)] focus-visible:outline-none top-1/2 -right-2 h-11 w-1 -translate-y-1/2 cursor-ew-resize"
        aria-label="Resize the viewport width"
        onpointerdown={(event) => startResize("east", event)}
        onkeydown={(event) => nudge("east", event)}
      ></button>
      <button
        type="button"
        class="absolute z-20 rounded-full bg-[var(--hairline-strongest)] transition-colors hover:bg-[var(--primary)] focus-visible:bg-[var(--primary)] focus-visible:outline-none -bottom-2 left-1/2 h-1 w-11 -translate-x-1/2 cursor-ns-resize"
        aria-label="Resize the viewport height"
        onpointerdown={(event) => startResize("south", event)}
        onkeydown={(event) => nudge("south", event)}
      ></button>
      <button
        type="button"
        class="absolute z-20 rounded-full bg-[var(--hairline-strongest)] transition-colors hover:bg-[var(--primary)] focus-visible:bg-[var(--primary)] focus-visible:outline-none -right-2 -bottom-2 size-2.5 cursor-nwse-resize"
        aria-label="Resize the viewport"
        onpointerdown={(event) => startResize("southeast", event)}
        onkeydown={(event) => nudge("southeast", event)}
      ></button>
    {/if}

    <!-- Floated over the page, the way every drawing tool puts its tools. The
         streamed canvas is an ordinary element in this frame, so it stacks
         normally; a native guest is painted over this frame by the app-root
         layer, which renders the same snippet in the same place instead. -->
    {#if annotation && !usesNativeSurface}
      <!-- The tools normally let pointer input reach the page. An open comment
           owns the frame until it is committed or skipped, so the page cannot
           select or activate an element behind the popup. -->
      <div
        class="absolute inset-0 z-20"
        class:pointer-events-auto={annotationBlocksSurface}
        class:pointer-events-none={!annotationBlocksSurface}
      >
        {@render annotation(fit.scale)}
      </div>
    {/if}
    </div>

    <!-- Mirrors the toolbar's size chip, over the canvas rather than in the
         chrome, so a drag can be read without leaving the frame. -->
    {#if page.viewport.mode !== "fill"}
      <span
        class="pointer-events-none absolute top-3 right-3.5 rounded-full bg-[color-mix(in_oklch,var(--background)_82%,transparent)] px-2.5 py-0.5 text-(--solus-text-tertiary) tabular-nums shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] backdrop-blur-md"
      >
        {statedViewport.width} × {statedViewport.height}{fit.scale > 0 &&
        fit.scale < 1
          ? ` · ${Math.round(fit.scale * 100)}%`
          : ""}
      </span>
    {/if}
  </div>

</div>

<style>
  /* A dot grid rather than a fill: it reads as ground under the page without
     ever being mistaken for part of it. */
  .browser-canvas__grid {
    opacity: 0.5;
    background-image: radial-gradient(
      circle at center,
      var(--hairline-strong) 0.5px,
      transparent 0.5px
    );
    background-size: 1rem 1rem;
  }

  .browser-flash {
    animation: browser-flash 420ms ease-out forwards;
  }

  @keyframes browser-flash {
    from {
      opacity: 0;
    }
    14% {
      opacity: 0.9;
    }
    to {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .browser-flash {
      animation: none;
      opacity: 0;
    }
  }
</style>
