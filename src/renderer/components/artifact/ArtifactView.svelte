<script lang="ts">
  import {
    ArrowsOutIcon,
    ArrowsInIcon,
    CheckIcon,
    CopyIcon,
  } from "phosphor-svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import { wrapSandboxSrcdoc } from "../../lib/artifactSandbox";

  interface Artifact {
    kind: "html" | "image";
    html?: string;
    path?: string;
    pending?: boolean;
  }

  let { artifact, skipMotion }: { artifact: Artifact; skipMotion?: boolean } =
    $props();

  const theme = getSettingsContext();

  const RASTER_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

  const ext = $derived(
    (artifact.path?.split(".").pop() ?? "").toLowerCase(),
  );
  const isRaster = $derived(
    artifact.kind === "image" && RASTER_EXTS.includes(ext),
  );
  const isSvg = $derived(artifact.kind === "image" && ext === "svg");

  /** solus-artifact:// URL for a local image file (path is absolute). */
  function protocolUrl(path: string): string {
    return `solus-artifact://local/?p=${encodeURIComponent(path)}`;
  }

  // Sandboxed-iframe substrate (ADR-0003) lives in lib/artifactSandbox. Reading
  // `theme.isDark` here keeps the srcdoc reactive: toggling the app theme
  // regenerates it with the opposite palette.
  function wrapSrcdoc(inner: string): string {
    return wrapSandboxSrcdoc(inner, theme.isDark);
  }

  // SVG renders through the iframe (scripts contained, no host inlining): fetch
  // the file via the protocol, then feed its text into srcdoc.
  let svgText = $state<string | null>(null);
  $effect(() => {
    if (!isSvg || !artifact.path) return;
    let cancelled = false;
    svgText = null;
    fetch(protocolUrl(artifact.path))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("not found"))))
      .then((t) => {
        if (!cancelled) svgText = t;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  const srcdoc = $derived.by(() => {
    if (artifact.kind === "html") return wrapSrcdoc(artifact.html ?? "");
    if (isSvg) return svgText !== null ? wrapSrcdoc(svgText) : null;
    return null;
  });

  let iframeEl = $state<HTMLIFrameElement | null>(null);
  let frameEl = $state<HTMLDivElement | null>(null);
  let contentHeight = $state(120);
  let expanded = $state(false);
  let copiedImage = $state(false);
  // Inline content width, captured the moment we expand. Fullscreen pins the
  // iframe to this width and scales the whole render up with a CSS transform, so
  // the result is a true zoom of the inline layout rather than a reflow.
  let nativeWidth = $state(0);
  // Inner size of the fullscreen overlay, tracked while expanded so the zoom
  // factor follows window resizes.
  let avail = $state({ w: 0, h: 0 });

  $effect(() => {
    function onMessage(e: MessageEvent) {
      if (!iframeEl || e.source !== iframeEl.contentWindow) return;
      const data = e.data as { type?: string; h?: number };
      if (data?.type !== "solus-artifact-height" || typeof data.h !== "number")
        return;
      // ceil (no additive buffer) keeps the height a stable fixed point. Any
      // positive padding feeds back forever for artifacts whose body tracks the
      // viewport (min-height:100vh, html/body{height:100%}): the taller frame
      // makes the body taller, which reports taller, which we pad again — the
      // perpetual creep that read as a resize stutter. Fullscreen keeps the
      // iframe pinned to its inline width, so the reported height stays the
      // inline content height even while expanded.
      contentHeight = Math.max(40, Math.ceil(data.h));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  function toggleExpand() {
    if (expanded) {
      expanded = false;
      requestInputFocus();
    } else {
      // Capture the inline width before the frame goes fixed and the iframe's
      // width:100% would resolve against the larger overlay instead.
      nativeWidth = iframeEl?.offsetWidth ?? 0;
      expanded = true;
    }
  }

  // The frame element IS the fixed overlay, so its client box is exactly the
  // space the zoomed render may fill. Observe it while expanded so the scale
  // recomputes on window resize.
  $effect(() => {
    if (!expanded || !frameEl) return;
    const update = () => {
      if (frameEl) avail = { w: frameEl.clientWidth, h: frameEl.clientHeight };
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(frameEl);
    return () => ro.disconnect();
  });

  // Uniform zoom that fits the inline render into the overlay, leaving a small
  // margin (0.92). 1 when collapsed — the iframe renders at its inline size.
  const scale = $derived(
    expanded && nativeWidth > 0 && avail.w > 0 && contentHeight > 0
      ? Math.min(avail.w / nativeWidth, avail.h / contentHeight) * 0.92
      : 1,
  );

  const artifactUrl = $derived(
    artifact.kind === "image" && artifact.path ? protocolUrl(artifact.path) : "",
  );
  async function copyImage() {
    if (!artifactUrl) return;
    try {
      const blob = await fetch(artifactUrl).then((r) => {
        if (!r.ok) throw new Error("Image not available");
        return r.blob();
      });
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      copiedImage = true;
      requestInputFocus();
      setTimeout(() => (copiedImage = false), 1500);
    } catch {}
  }

  $effect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        expanded = false;
        requestInputFocus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const colorScheme = $derived(theme.isDark ? "dark" : "light");
</script>

{#if artifact.pending}
  <div
    class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}"
    data-testid="artifact-generating"
  >
    <!-- Anticipatory skeleton: faux content silhouettes (title, canvas, caption)
         sit on a tall warm "stage", and a brand-accent fill wipes across each in
         sequence — so a rich visualization reads as streaming into place rather
         than a short box blinking. No status text: the motion is self-evidently a
         render, and the label is screen-reader-only to keep the chrome clean. -->
    <div
      class="artifact-skeleton"
      role="status"
      aria-label="Rendering visualization"
    >
      <div class="sk-row sk-title"><span class="sk-fill"></span></div>
      <div class="sk-row sk-block"><span class="sk-fill"></span></div>
      <div class="sk-row sk-line"><span class="sk-fill"></span></div>
      <div class="sk-row sk-line2"><span class="sk-fill"></span></div>
    </div>
  </div>
{:else}
  <div class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
    {#if expanded}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="artifact-backdrop"
        onclick={() => {
          expanded = false;
          requestInputFocus();
        }}
      ></div>
    {/if}

    <!-- The frame element is never re-created or moved between collapsed and
         expanded: expand only toggles a position:fixed class, so the iframe keeps
         all live state (no remount/reload). -->
    <div
      class="artifact-frame"
      class:expanded
      data-testid="artifact-view"
      bind:this={frameEl}
    >
      {#if isRaster && artifact.path}
        <img
          class="artifact-img"
          src={artifactUrl}
          alt="Rendered artifact"
          data-testid="artifact-image"
        />
      {:else if srcdoc !== null}
        <iframe
          bind:this={iframeEl}
          title="Rendered artifact"
          class="artifact-iframe"
          data-testid="artifact-iframe"
          sandbox="allow-scripts"
          style="color-scheme:{colorScheme};{expanded
            ? `width:${nativeWidth}px;height:${contentHeight}px;transform:scale(${scale})`
            : `height:${contentHeight}px`}"
          {srcdoc}
        ></iframe>
      {:else}
        <div class="artifact-loading">
          <span class="artifact-skeleton-dot"></span>
        </div>
      {/if}

      {#if srcdoc !== null || isRaster}
        <div class="artifact-actions">
          {#if isRaster && artifactUrl}
            <button
              class="artifact-action"
              class:is-copied={copiedImage}
              data-testid="artifact-copy-image"
              onclick={copyImage}
              use:tooltip={copiedImage ? "Copied image" : "Copy image"}
              aria-label="Copy image"
            >
              <span class="artifact-icon-swap">
                <CopyIcon
                  size={14}
                  weight="bold"
                  class={copiedImage ? "icon-hidden" : ""}
                />
                <CheckIcon
                  size={14}
                  weight="bold"
                  class={copiedImage ? "" : "icon-hidden"}
                />
              </span>
            </button>
          {/if}
          <button
            class="artifact-action"
            data-testid="artifact-expand"
            onclick={toggleExpand}
            use:tooltip={expanded ? "Collapse · Esc" : "Expand"}
            aria-label={expanded ? "Collapse artifact" : "Expand artifact"}
          >
            {#if expanded}
              <ArrowsInIcon size={14} weight="bold" />
            {:else}
              <ArrowsOutIcon size={14} weight="bold" />
            {/if}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .artifact-frame {
    position: relative;
    min-width: 0;
    max-width: 100%;
    border-radius: 0.75rem;
    overflow: hidden;
    /* No border, no fill: the frame itself is invisible. The injected Solus
       palette lets the artifact's own markup match the chat, so it reads as
       embedded content rather than a card dropped into the conversation. The
       radius only bites when the artifact paints its own background. */
    border: 0;
    background: transparent;
  }

  .artifact-frame.expanded {
    position: fixed;
    inset: 2.5rem;
    z-index: 60;
    /* Fullscreen sits on a readable surface so artifacts with transparent areas
       stay legible above the dimmed backdrop. The zoomed iframe is centered in
       this box; `safe` keeps the top/left reachable if it ever overflows. */
    display: flex;
    align-items: safe center;
    justify-content: safe center;
    overflow: auto;
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-tool-border);
    box-shadow: 0 1.5rem 4rem rgba(0, 0, 0, 0.45);
  }

  /* Expand uses position:fixed to fill the viewport, but the artifact's ancestors
     (.cv-list rows and .tab-slot) carry content-visibility:auto — its paint
     containment would otherwise make them the containing block and clip the
     "fullscreen" frame inside the message row. Releasing containment only on the
     specific ancestors holding the expanded artifact lets it reach the viewport
     without reparenting the iframe (which would reload it and lose live state). */
  :global(.cv-list > *:has(.artifact-frame.expanded)),
  :global(.tab-slot:has(.artifact-frame.expanded)) {
    content-visibility: visible;
    contain-intrinsic-size: auto;
  }

  .artifact-backdrop {
    position: fixed;
    inset: 0;
    z-index: 59;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(0.125rem);
  }

  .artifact-iframe {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    /* Zoom from the center when fullscreen scales it up. */
    transform-origin: center center;
    /* Animate height changes so the frame growing/shrinking in response to an
       interaction (content reflow inside the artifact) glides instead of
       snapping — the jitter the user saw. contentHeight is a stable fixed
       point, so this only smooths the transition between settled heights. */
    transition: height 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .artifact-frame.expanded .artifact-iframe {
    /* Fullscreen pins width and scales via transform — no height to animate. */
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .artifact-iframe {
      transition: none;
    }
  }

  .artifact-img {
    display: block;
    width: auto;
    max-width: 75%;
    max-height: clamp(12rem, 51svh, 31.5rem);
    height: auto;
    object-fit: contain;
    margin-inline: auto;
  }

  .artifact-frame.expanded .artifact-img {
    width: 100%;
    height: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  @media (max-width: 40rem) {
    .artifact-frame {
      border-radius: min(2vw, 0.75rem);
    }

    .artifact-img {
      max-height: min(45svh, 22.5rem);
    }

    .artifact-skeleton {
      gap: 0.625rem;
      min-height: clamp(9.5rem, 30svh, 13rem);
      padding: 1.125rem;
      border-radius: min(2vw, 0.75rem);
    }
  }

  .artifact-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 6rem;
  }

  .artifact-actions {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: inline-flex;
    gap: 0.375rem;
    opacity: 0;
    transform: translateY(-0.1875rem) scale(0.96);
    transition:
      opacity 0.16s ease,
      transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .artifact-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 0.625rem;
    border: 0.0625rem solid
      color-mix(in srgb, var(--solus-tool-border) 65%, transparent);
    background: color-mix(in srgb, var(--solus-container-bg) 70%, transparent);
    backdrop-filter: blur(0.625rem) saturate(1.3);
    -webkit-backdrop-filter: blur(0.625rem) saturate(1.3);
    color: var(--solus-text-secondary);
    cursor: pointer;
    box-shadow:
      0 0.0625rem 0.125rem rgba(0, 0, 0, 0.08),
      0 0.25rem 0.75rem rgba(0, 0, 0, 0.06);
    text-decoration: none;
    transition:
      background 0.16s ease,
      color 0.16s ease,
      border-color 0.16s ease,
      box-shadow 0.16s ease,
      transform 0.12s ease;
  }

  .artifact-frame:hover .artifact-actions,
  .artifact-frame:focus-within .artifact-actions,
  .artifact-frame.expanded .artifact-actions {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .artifact-action:hover {
    background: var(--solus-surface-hover);
    border-color: var(--solus-accent-border-medium);
    color: var(--solus-accent);
    box-shadow:
      0 0.125rem 0.25rem rgba(0, 0, 0, 0.1),
      0 0.375rem 1rem rgba(0, 0, 0, 0.08);
  }

  .artifact-action.is-copied {
    background: color-mix(
      in srgb,
      var(--solus-accent-soft) 70%,
      var(--solus-container-bg)
    );
    border-color: var(--solus-accent-border-medium);
    color: var(--solus-accent);
    box-shadow:
      0 0.125rem 0.25rem rgba(0, 0, 0, 0.1),
      0 0.375rem 1rem rgba(0, 0, 0, 0.08);
  }

  .artifact-action:active {
    transform: scale(0.96);
  }

  .artifact-action:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .artifact-icon-swap {
    position: relative;
    display: inline-flex;
    width: 0.875rem;
    height: 0.875rem;
    align-items: center;
    justify-content: center;
  }

  .artifact-icon-swap :global(svg) {
    position: absolute;
    transition:
      opacity 0.2s cubic-bezier(0.2, 0, 0, 1),
      transform 0.2s cubic-bezier(0.2, 0, 0, 1),
      filter 0.2s cubic-bezier(0.2, 0, 0, 1);
  }

  .artifact-icon-swap :global(svg.icon-hidden) {
    opacity: 0;
    transform: scale(0.25);
    filter: blur(0.25rem);
  }

  .artifact-icon-swap :global(svg:not(.icon-hidden)) {
    opacity: 1;
    transform: scale(1);
    filter: blur(0);
  }

  @media (prefers-reduced-motion: reduce) {
    .artifact-actions,
    .artifact-action,
    .artifact-icon-swap :global(svg) {
      transition:
        opacity 0.16s ease,
        background 0.16s ease,
        color 0.16s ease,
        border-color 0.16s ease;
      transform: none;
    }
    .artifact-frame:hover .artifact-actions,
    .artifact-frame:focus-within .artifact-actions,
    .artifact-frame.expanded .artifact-actions,
    .artifact-action:active,
    .artifact-icon-swap :global(svg) {
      transform: none;
    }
  }

  /* Tall warm "stage" the visualization will land on — reserves a generous
     footprint so the render reads as imminent rather than a short box. A faint
     parchment wash + hairline give it presence without competing with the
     artifact that swaps in. */
  .artifact-skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.8125rem;
    /* Track the window height (svh) so the reserved footprint scales with the
       device, bounded so it never gets cramped on short windows or oversized on
       tall displays. */
    min-height: clamp(11rem, 24svh, 15rem);
    padding: 1.5rem;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--solus-art-surface) 60%, transparent);
    border: 0.0625rem solid var(--solus-art-border);
  }

  /* Each silhouette bone. A brand-accent fill wipes across it left→right; the
     bones are staggered so content reads as streaming into place in sequence. */
  .sk-row {
    position: relative;
    overflow: hidden;
    border-radius: 0.4375rem;
    background: color-mix(in srgb, var(--solus-text-primary) 9%, transparent);
  }

  .sk-fill {
    position: absolute;
    inset: 0;
    transform-origin: left;
    transform: scaleX(0);
    background: color-mix(in srgb, var(--solus-accent) 30%, transparent);
    animation: artifact-wipe 2.8s ease-in-out infinite;
  }

  .sk-title {
    width: 46%;
    height: 0.8125rem;
  }

  /* The "canvas" block grows to fill the stage so the footprint stays tall. */
  .sk-block {
    flex: 1;
    min-height: 4.5rem;
  }

  .sk-line {
    width: 80%;
    height: 0.6875rem;
  }

  .sk-line2 {
    width: 60%;
    height: 0.6875rem;
  }

  .sk-title .sk-fill {
    animation-delay: 0s;
  }
  .sk-block .sk-fill {
    animation-delay: 0.2s;
  }
  .sk-line .sk-fill {
    animation-delay: 0.4s;
  }
  .sk-line2 .sk-fill {
    animation-delay: 0.55s;
  }

  @keyframes artifact-wipe {
    0% {
      transform: scaleX(0);
      opacity: 1;
    }
    45%,
    70% {
      transform: scaleX(1);
      opacity: 1;
    }
    100% {
      transform: scaleX(1);
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk-fill {
      animation: none;
      transform: scaleX(1);
      opacity: 0.5;
    }
  }

  .artifact-skeleton-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: var(--solus-accent);
    animation: artifact-pulse 1.2s ease-in-out infinite;
  }

  @keyframes artifact-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.85);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
