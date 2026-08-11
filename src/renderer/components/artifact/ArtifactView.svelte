<script lang="ts">
  import {
    ArrowsOutIcon,
    ArrowsInIcon,
    CheckIcon,
    CopyIcon,
  } from "phosphor-svelte";
  import {
    getSettingsContext,
    getWindowContext,
    getWorkspaceContext,
    hostCapabilitiesStore,
    serversStore,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { wrapSandboxSrcdoc } from "../../lib/artifactSandbox";
  import { serverConnections } from "@client-core/server-connections";
  import { hostPolicy } from "@client-core/host-policy";
  import { unsupportedOnHost } from "@client-core/host-capabilities";
  import {
    assetUrlCache,
    localArtifactProtocolUrl,
  } from "./lib/asset-url";

  interface Artifact {
    kind: "html" | "image";
    html?: string;
    path?: string;
    pending?: boolean;
  }

  let {
    artifact,
    tabId,
    skipMotion,
  }: { artifact: Artifact; tabId: string; skipMotion?: boolean } = $props();

  const theme = getSettingsContext();
  const windowCtx = getWindowContext();
  const session = getWorkspaceContext();

  const RASTER_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

  const ext = $derived(
    (artifact.path?.split(".").pop() ?? "").toLowerCase(),
  );
  const isRaster = $derived(
    artifact.kind === "image" && RASTER_EXTS.includes(ext),
  );
  const isSvg = $derived(artifact.kind === "image" && ext === "svg");

  let artifactUrl = $state("");
  let artifactError = $state<string | null>(null);
  $effect(() => {
    const path = artifact.kind === "image" ? artifact.path : undefined;
    const run = session.runFor(tabId);
    if (!path || !run) {
      artifactUrl = "";
      artifactError = null;
      return;
    }
    if (!windowCtx.isWeb && hostPolicy.isClientMachine(run.serverId)) {
      artifactUrl = localArtifactProtocolUrl(path);
      artifactError = null;
      return;
    }

    const capabilities = hostCapabilitiesStore.for(run.serverId);
    if (capabilities === undefined) {
      artifactUrl = "";
      artifactError = null;
      void hostCapabilitiesStore.load(run.serverId);
      return;
    }
    if (capabilities.assetUrls !== true) {
      const hostLabel =
        serversStore.hostFor(run.serverId)?.label ??
        serverConnections.connectionFor(run.serverId)?.target.label ??
        "this host";
      artifactUrl = "";
      artifactError = unsupportedOnHost("Artifact images", hostLabel);
      return;
    }

    let cancelled = false;
    artifactUrl = "";
    artifactError = null;
    void assetUrlCache
      .resolve({
        serverId: run.serverId,
        path,
        origin: serverConnections.httpOriginFor(run.serverId),
        api: session.apiFor(tabId),
        ctx: session.ctxFor(tabId),
      })
      .then((url) => {
        if (!cancelled) artifactUrl = url;
      })
      .catch(() => {
        if (!cancelled) artifactError = "This artifact image is unavailable.";
      });
    return () => {
      cancelled = true;
    };
  });

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
    if (!isSvg || !artifactUrl) return;
    let cancelled = false;
    svgText = null;
    fetch(artifactUrl)
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
         on a tall warm "stage". Bones rest neutral — the brand colour never sits
         as a fill, it only travels: a 10% accent highlight sweeping the bones
         plus a 2px indeterminate hairline. The header names the payload in
         words, because a rectangle of washes is the one moment the reader
         cannot tell what is arriving. -->
    <div
      class="artifact-skeleton"
      role="status"
      aria-label="Rendering visualization"
    >
      <div class="artifact-skeleton__head">
        <span class="artifact-skeleton__kicker">Artifact</span>
        <span class="artifact-skeleton__status font-mono">rendering</span>
      </div>
      <div class="artifact-skeleton__rule"></div>
      <div class="artifact-skeleton__body">
        <div class="sk-bar sk-title"></div>
        <div class="sk-bar sk-block"></div>
        <div class="sk-bar sk-line"></div>
        <div class="sk-bar sk-line2"></div>
      </div>
      <div class="artifact-skeleton__track">
        <div class="artifact-skeleton__progress"></div>
      </div>
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
      {#if artifactError}
        <div
          class="flex min-h-28 items-center justify-center rounded-2xl border border-(--solus-status-error)/20 bg-(--solus-status-error)/5 px-5 text-center text-[0.8125rem] text-(--solus-text-secondary)"
          role="alert"
          data-testid="artifact-error"
        >
          {artifactError}
        </div>
      {:else if isRaster && artifact.path}
        <img
          class="artifact-img"
          src={artifactUrl}
          alt="Rendered artifact"
          data-testid="artifact-image"
          onerror={() => (artifactError = "This artifact image is unavailable.")}
        />
      {:else if srcdoc !== null}
        <iframe
          bind:this={iframeEl}
          title="Rendered artifact"
          class="artifact-iframe"
          data-testid="artifact-iframe"
          sandbox="allow-scripts"
          allow="clipboard-write"
          style="color-scheme:{colorScheme};{expanded
            ? `width:${nativeWidth}px;height:${contentHeight}px;transform:scale(${scale})`
            : `height:${contentHeight}px`}"
          {srcdoc}
        ></iframe>
      {:else}
        <div class="artifact-loading" role="status" aria-label="Loading artifact">
          <div class="sk-bar artifact-loading__bone"></div>
        </div>
      {/if}

      {#if !artifactError && (srcdoc !== null || isRaster)}
        <div class="artifact-actions">
          {#if isRaster && artifactUrl}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <button {...tooltipProps}
              class="artifact-action"
              class:is-copied={copiedImage}
              data-testid="artifact-copy-image"
              onclick={copyImage}
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
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value={copiedImage ? "Copied image" : "Copy image"} />
            </TooltipUI.Root>
          {/if}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <button {...tooltipProps}
            class="artifact-action"
            data-testid="artifact-expand"
            onclick={toggleExpand}
            aria-label={expanded ? "Collapse artifact" : "Expand artifact"}
          >
            {#if expanded}
              <ArrowsInIcon size={14} weight="bold" />
            {:else}
              <ArrowsOutIcon size={14} weight="bold" />
            {/if}
          </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={expanded ? "Collapse · Esc" : "Expand"} />
          </TooltipUI.Root>
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
    border-radius: 1rem;
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
      min-height: clamp(9.5rem, 30svh, 13rem);
      border-radius: min(2vw, 0.75rem);
    }

    .artifact-skeleton__body {
      gap: 0.625rem;
      padding: 0.875rem 0.875rem 0.8125rem;
    }
  }

  /* Brief hydration gap between the file landing and the iframe painting —
     the same quiet bone as the skeleton's canvas block, not a spinner. */
  .artifact-loading {
    display: flex;
    min-height: 6rem;
  }

  .sk-bar.artifact-loading__bone {
    --sk-ink: 4%;
    flex: 1;
    border-radius: 0.5rem;
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in srgb, var(--solus-text-primary) 9%, transparent);
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
    border-radius: 0.5rem;
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
    overflow: hidden;
    /* Track the window height (svh) so the reserved footprint scales with the
       device, bounded so it never gets cramped on short windows or oversized on
       tall displays. */
    min-height: clamp(11rem, 24svh, 15rem);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--solus-art-surface) 60%, transparent);
    border: 0.0625rem solid var(--solus-art-border);
  }

  .artifact-skeleton__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.8125rem 1.0625rem 0.6875rem;
  }

  .artifact-skeleton__kicker {
    font-size: 0.59375rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .artifact-skeleton__status {
    margin-left: auto;
    font-size: 0.65625rem;
    color: var(--muted-foreground);
    animation: artifact-sk-breathe 2.6s ease-in-out infinite;
  }

  .artifact-skeleton__rule {
    height: 0.0625rem;
    background: var(--solus-tx-rule);
  }

  .artifact-skeleton__body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.6875rem;
    padding: 1rem 1rem 0.9375rem;
  }

  /* Each bone rests at a quiet ink wash; the accent exists only inside the
     highlight travelling across it. Ink tints mix in srgb, never oklch —
     transparent's oklch hue is 0 and a polar mix turns warm brown pink. The
     sweep runs on the transcript's 2.4s shimmer clock, rows offset by -0.4s so
     the highlight reads as one pass moving down the stage. */
  .sk-bar {
    --sk-ink: 6%;
    border-radius: 9999px;
    background-image: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-text-primary) var(--sk-ink), transparent) 0%,
      color-mix(in srgb, var(--solus-accent) 10%, transparent) 45%,
      color-mix(in srgb, var(--solus-text-primary) var(--sk-ink), transparent) 90%
    );
    background-size: 260% 100%;
    animation: artifact-sk-shim 2.4s linear infinite;
  }

  .sk-title {
    --sk-ink: 7%;
    width: 46%;
    height: 0.6875rem;
  }

  /* The "canvas" block grows to fill the stage so the footprint stays tall. */
  .sk-block {
    --sk-ink: 4%;
    flex: 1;
    min-height: 4.5rem;
    border-radius: 0.5rem;
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in srgb, var(--solus-text-primary) 9%, transparent);
    animation-delay: -0.4s;
  }

  .sk-line {
    width: 92%;
    height: 0.5625rem;
    animation-delay: -0.8s;
  }

  .sk-line2 {
    width: 58%;
    height: 0.5625rem;
    animation-delay: -1.2s;
  }

  .artifact-skeleton__track {
    height: 0.125rem;
    overflow: hidden;
    background: color-mix(in srgb, var(--solus-text-primary) 6%, transparent);
  }

  .artifact-skeleton__progress {
    height: 100%;
    width: 34%;
    background: var(--solus-accent);
    opacity: 0.5;
    animation: artifact-sk-indet 1.6s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }

  @keyframes artifact-sk-shim {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -100% 0;
    }
  }

  @keyframes artifact-sk-breathe {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 0.85;
    }
  }

  @keyframes artifact-sk-indet {
    from {
      transform: translateX(-45%);
    }
    to {
      transform: translateX(245%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk-bar {
      animation: none;
      background-image: none;
      background-color: color-mix(
        in srgb,
        var(--solus-text-primary) var(--sk-ink),
        transparent
      );
    }
    .artifact-skeleton__status {
      animation: none;
      opacity: 0.6;
    }
    .artifact-skeleton__progress {
      animation: none;
      opacity: 0.35;
    }
  }

</style>
