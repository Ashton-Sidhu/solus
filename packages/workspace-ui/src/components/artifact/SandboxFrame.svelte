<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import {
    Maximize as ArrowsOutIcon,
    Minimize as ArrowsInIcon,
  } from "@lucide/svelte";
  import { getSettingsContext, runtime } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { buildSandboxThemeCss, wrapSandboxSrcdoc } from "../../lib/artifactSandbox";
  import { artifactHeightMessageSchema, expandScale } from "./lib/artifact-view";

  /**
   * The one place agent HTML runs: a sandboxed iframe carrying a
   * mirror of the live Solus theme, growing to the height its content reports,
   * and expanding to a fullscreen overlay without ever being re-created.
   *
   * Every render surface in Solus goes through this component — the artifact
   * card, an HTML block in a reply, a document or plan embed, an `.html` file
   * preview. Image artifacts are the one render that is not HTML; they reuse
   * the frame's chrome through `children` rather than growing a second one.
   */
  interface Props {
    /** The markup to run. Undefined renders nothing — the caller owns its own
     *  loading state, which must not sit inside an expandable frame. */
    html?: string;
    /** Rendered in place of the iframe. The image artifact's one use. */
    children?: Snippet;
    /** Extra buttons for the hover action cluster, before Expand. */
    actions?: Snippet;
    /** Let a pane render use all available height while transcript, task, and
     *  document renders continue to size themselves to their content. */
    fillAvailable?: boolean;
    expandable?: boolean;
    /** Hold the iframe back until the frame is near the viewport. A document or
     *  transcript full of renders then costs one frame per render the reader
     *  actually reaches. Once mounted it stays mounted. */
    lazy?: boolean;
    /** Bumping this is the only thing that re-creates the iframe: a retry or an
     *  explicit reload. Theme messages update the palette without reloading the document. */
    reloadKey?: number;
    onError?: () => void;
    /** Where Expand goes on a touch client: the fullscreen overlay duplicates
     *  a work's own mobile surface and can trap the reader in it, so a render
     *  that HAS a work opens the work instead. A render with no work — an
     *  ephemeral HTML block — has nowhere else to go and keeps the overlay. */
    onExpandOnTouch?: () => void;
    /* The two props below exist for one reason: a Tiptap node view is mounted
       with `mount()`, outside the component tree, so neither the settings
       context nor the app's tooltip provider is reachable from it. Those
       callers hand the theme in and ask for plain titles instead. */
    isDark?: boolean;
    tooltips?: boolean;
  }

  let {
    html,
    children,
    actions,
    fillAvailable = false,
    expandable = true,
    lazy = true,
    reloadKey = 0,
    onError,
    isDark,
    tooltips = true,
    onExpandOnTouch,
  }: Props = $props();

  // A caller is either inside the component tree or outside it for its whole
  // life, so this choice is made once and never re-made.
  const settings = untrack(() => isDark) === undefined ? getSettingsContext() : null;
  // Theme updates are messages: assigning srcdoc would reset live state.
  const dark = $derived(isDark ?? settings!.isDark);

  const srcdoc = $derived(html === undefined ? null : wrapSandboxSrcdoc(html, untrack(() => dark)));

  let iframeEl = $state<HTMLIFrameElement | null>(null);
  function syncTheme() {
    iframeEl?.contentWindow?.postMessage({
      type: "solus-artifact-theme",
      css: buildSandboxThemeCss(dark),
    }, "*");
  }

  $effect(() => {
    void dark;
    let cancelled = false;
    // Let the host's CSS theme settle before reading its computed palette.
    void tick().then(() => { if (!cancelled) syncTheme(); });
    return () => { cancelled = true; };
  });

  let frameEl = $state<HTMLDivElement | null>(null);
  let contentHeight = $state(120);
  let expanded = $state(false);
  let isNearViewport = $state(untrack(() => !lazy));
  // Inline content width, captured the moment we expand. Fullscreen pins the
  // iframe to this width and scales the whole render up with a CSS transform, so
  // the result is a true zoom of the inline layout rather than a reflow.
  let nativeWidth = $state(0);
  // Inner size of the fullscreen overlay, tracked while expanded so the zoom
  // factor follows window resizes.
  let avail = $state({ w: 0, h: 0 });

  $effect(() => {
    if (isNearViewport) return;
    const element = frameEl;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      isNearViewport = true;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          isNearViewport = true;
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    function onMessage(e: MessageEvent) {
      if (!iframeEl || e.source !== iframeEl.contentWindow) return;
      const parsed = artifactHeightMessageSchema.safeParse(e.data);
      if (!parsed.success) return;
      // ceil (no additive buffer) keeps the height a stable fixed point. Any
      // positive padding feeds back forever for renders whose body tracks the
      // viewport (min-height:100vh, html/body{height:100%}): the taller frame
      // makes the body taller, which reports taller, which we pad again — the
      // perpetual creep that read as a resize stutter. Fullscreen keeps the
      // iframe pinned to its inline width, so the reported height stays the
      // inline content height even while expanded.
      contentHeight = Math.max(40, Math.ceil(parsed.data.h));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  const handsOffOnTouch = $derived(!!onExpandOnTouch && runtime.isMobileViewport);

  function toggleExpand() {
    if (handsOffOnTouch) {
      onExpandOnTouch?.();
      return;
    }
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

  $effect(() => {
    if (handsOffOnTouch) expanded = false;
  });

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

  const scale = $derived(
    expanded ? expandScale(nativeWidth, contentHeight, avail) : 1,
  );

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

  const colorScheme = $derived(dark ? "dark" : "light");
</script>

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
  class:fill-available={fillAvailable}
  data-testid="artifact-view"
  bind:this={frameEl}
>
  {#if children}
    {@render children()}
  {:else if srcdoc !== null && isNearViewport}
    {#key reloadKey}
      <iframe
        bind:this={iframeEl}
        title="Rendered artifact"
        class="artifact-iframe"
        class:fill-available={fillAvailable}
        data-testid="artifact-iframe"
        sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads"
        allow="clipboard-write"
        style="color-scheme:{colorScheme};{expanded
          ? `width:${nativeWidth}px;height:${contentHeight}px;transform:scale(${scale})`
          : `height:${contentHeight}px`}"
        onload={syncTheme}
        onerror={() => onError?.()}
        {srcdoc}
      ></iframe>
    {/key}
  {:else if srcdoc !== null}
    <!-- Reserves the frame's resting height so a scroll past an unmounted
         render does not jump when the iframe lands. -->
    <div class="artifact-placeholder" style="height:{contentHeight}px"></div>
  {/if}

  {#if (children || srcdoc !== null) && (actions || expandable)}
    <div class="artifact-actions">
      {@render actions?.()}
      {#if expandable}
        {#snippet expandButton(extra: import("svelte/elements").HTMLButtonAttributes)}
          <button
            {...extra}
            class="artifact-action"
            data-testid="artifact-expand"
            title={tooltips ? undefined : expanded ? "Collapse · Esc" : "Expand"}
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
        {#if tooltips}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                {@render expandButton(tooltipProps)}
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={expanded ? "Collapse · Esc" : "Expand"} />
          </TooltipUI.Root>
        {:else}
          {@render expandButton({})}
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .artifact-frame {
    position: relative;
    min-width: 0;
    max-width: 100%;
    border-radius: 1rem;
    overflow: hidden;
    /* No border, no fill: the frame itself is invisible. The injected Solus
       palette lets the render's own markup match the app, so it reads as
       embedded content rather than a card dropped into the conversation. The
       radius only bites when the render paints its own background. */
    border: 0;
    background: transparent;
  }

  .artifact-frame.fill-available {
    min-height: 100%;
  }

  .artifact-frame.expanded {
    position: fixed;
    inset: 2.5rem;
    z-index: 60;
    /* Fullscreen sits on a readable surface so renders with transparent areas
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

  /* Expand uses position:fixed to fill the viewport, but the frame's ancestors
     (.cv-list rows and .tab-slot) carry content-visibility:auto — its paint
     containment would otherwise make them the containing block and clip the
     "fullscreen" frame inside the message row. Releasing containment only on the
     specific ancestors holding the expanded frame lets it reach the viewport
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
       interaction (content reflow inside the render) glides instead of
       snapping — the jitter the user saw. contentHeight is a stable fixed
       point, so this only smooths the transition between settled heights. */
    transition: height 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .artifact-iframe.fill-available {
    min-height: 100%;
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

  .artifact-placeholder {
    display: block;
    width: 100%;
  }

  @media (max-width: 40rem) {
    .artifact-frame {
      border-radius: min(2vw, 0.75rem);
    }

    .artifact-frame.expanded {
      inset:
        max(0.5rem, env(safe-area-inset-top, 0))
        max(0.5rem, env(safe-area-inset-right, 0))
        max(0.5rem, env(safe-area-inset-bottom, 0))
        max(0.5rem, env(safe-area-inset-left, 0));
    }
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

  /* `:global` so a caller's own action button, handed in through the `actions`
     snippet, wears the same chrome as the frame's Expand. */
  .artifact-actions :global(.artifact-action) {
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

  /* A labelled action (Source, Save as artifact) needs room for its word. */
  .artifact-actions :global(.artifact-action.is-labelled) {
    width: auto;
    gap: 0.3125rem;
    padding-inline: 0.5rem;
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .artifact-frame:hover .artifact-actions,
  .artifact-frame:focus-within .artifact-actions,
  .artifact-frame.expanded .artifact-actions {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  /* A phone has no hover pass that can reveal these controls before the iframe
     takes the tap. Keep them present and large enough to operate directly. */
  @media (hover: none), (pointer: coarse) {
    .artifact-actions {
      opacity: 1;
      transform: none;
    }

    .artifact-actions :global(.artifact-action) {
      width: 2.5rem;
      height: 2.5rem;
    }

    .artifact-actions :global(.artifact-action.is-labelled) {
      width: auto;
    }
  }

  .artifact-actions :global(.artifact-action:hover) {
    background: var(--solus-surface-hover);
    border-color: var(--solus-accent-border-medium);
    color: var(--solus-accent);
    box-shadow:
      0 0.125rem 0.25rem rgba(0, 0, 0, 0.1),
      0 0.375rem 1rem rgba(0, 0, 0, 0.08);
  }

  .artifact-actions :global(.artifact-action.is-copied) {
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

  .artifact-actions :global(.artifact-action:active) {
    transform: scale(0.96);
  }

  .artifact-actions :global(.artifact-action:focus-visible) {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .artifact-actions,
    .artifact-actions :global(.artifact-action) {
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
    .artifact-actions :global(.artifact-action:active) {
      transform: none;
    }
  }
</style>
