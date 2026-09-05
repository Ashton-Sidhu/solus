<script lang="ts">
  import {
    ChevronLeft,
    ChevronRight,
    Eraser,
    ExternalLink,
    Highlighter,
    Lock,
    RotateCw,
    Moon,
    Sun,
    SunMoon,
    SquareTerminal,
  } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import type {
    BrowserAppearance,
    BrowserPage,
    BrowserViewport,
    BrowserViewportRequest,
  } from "@solus/contracts/browser-types";
  import { addressParts, navigableAddress } from "./lib/address";
  import * as TooltipUI from "../ui/tooltip";
  import BrowserViewportChip from "./BrowserViewportChip.svelte";

  /**
   * Where the user says what they want to look at: history, the address, the
   * size, and the tools that act on the page.
   *
   * Read left to right it is navigate, locate, size, act, leave. Nothing in it
   * may compete with the page below — every control is a ghost button on the
   * pane's own surface, and the only raised things are the address field, which
   * is recessed, and the size chip, which is the setting changed most.
   */

  interface Props {
    page: BrowserPage;
    /** The size being steered right now, which leads the host's answer during a
     *  drag. The chip states it; the stage still renders what the host confirmed. */
    statedViewport: BrowserViewport;
    /** How much the stage had to shrink the device to fit, 0–1. */
    scale: number;
    onNavigate: (action: "back" | "forward" | "reload") => void;
    onGoto: (url: string) => void;
    onViewport: (request: BrowserViewportRequest) => void;
    onAppearance: (appearance: BrowserAppearance) => void;
    onClearProfile: () => void;
    /** Absent where the inspector cannot open on the user's own screen: a page
     *  rendered by a headless browser on a server elsewhere. */
    onOpenDevTools?: (() => void) | undefined;
    /** Hand the address to the user's own browser. Absent on the same terms as
     *  DevTools: where the guest is rendered somewhere else, this machine's
     *  browser would resolve the address against the wrong host. */
    onOpenExternal?: (() => void) | undefined;
    /** True while the annotation tools are showing, so the toggle can say so. */
    annotating: boolean;
    onToggleAnnotating: () => void;
    /** The capture control. Passed in rather than built here: what a capture
     *  can be attached to is the pane's business, not the address bar's. */
    capture?: Snippet;
    /** Which identity this page is signed in as. Passed in for the same reason
     *  the capture control is: the profile set belongs to the project, which the
     *  address bar knows nothing about. */
    profile?: Snippet;
  }

  let {
    page,
    statedViewport,
    scale,
    onNavigate,
    onGoto,
    onViewport,
    onAppearance,
    onClearProfile,
    onOpenDevTools,
    onOpenExternal,
    annotating,
    onToggleAnnotating,
    capture,
    profile,
  }: Props = $props();

  /** Held only while the field is being typed in. The address field is a display
   *  of where the page is until the user takes it over. */
  let editing = $state(false);
  let draft = $state("");
  const parts = $derived(addressParts(page.url));
  const loading = $derived(page.loadState === "loading");

  function beginEditing() {
    draft = page.url;
    editing = true;
  }

  function commit(event: SubmitEvent) {
    event.preventDefault();
    const url = navigableAddress(draft);
    editing = false;
    if (url && url !== page.url) onGoto(url);
  }

  const APPEARANCE_ORDER: BrowserAppearance[] = ["system", "light", "dark"];
  const nextAppearance = $derived(
    APPEARANCE_ORDER[
      (APPEARANCE_ORDER.indexOf(page.appearance) + 1) % APPEARANCE_ORDER.length
    ],
  );
</script>

<div
  class="@container/toolbar relative flex h-[2.625rem] shrink-0 items-center gap-1.5 border-b border-[var(--hairline)] pr-2 pl-1.5"
>
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <!-- The span remains hoverable when browser history disables the button. -->
        <span {...props} class="inline-flex shrink-0">
          <button
            type="button"
            class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30"
            disabled={!page.canGoBack}
            aria-label="Back"
            onclick={() => onNavigate("back")}
          >
            <ChevronLeft class="size-3.5" />
          </button>
        </span>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content class="z-[10050]" side="bottom" value="Go back" />
  </TooltipUI.Root>
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <span
          {...props}
          class="inline-flex shrink-0 @max-[26rem]/toolbar:hidden"
        >
          <button
            type="button"
            class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30"
            disabled={!page.canGoForward}
            aria-label="Forward"
            onclick={() => onNavigate("forward")}
          >
            <ChevronRight class="size-3.5" />
          </button>
        </span>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content class="z-[10050]" side="bottom" value="Go forward" />
  </TooltipUI.Root>
  <!-- The reload glyph carries the loading motion, so the canvas needs no
       spinner of its own over the page being judged. -->
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30"
          aria-label="Reload"
          onclick={() => onNavigate("reload")}
        >
          <RotateCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content class="z-[10050]" side="bottom" value="Reload browser" />
  </TooltipUI.Root>

  <!-- Recessed rather than raised: this is the one place in the pane you type. -->
  {#if editing}
    <form
      class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[0.625rem] bg-[var(--wash-1)] px-2.5 shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest)]"
      onsubmit={commit}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="text-workspace-chrome min-w-0 flex-1 bg-transparent text-(--solus-text-primary) outline-none"
        spellcheck="false"
        autocomplete="off"
        autofocus
        aria-label="Browser address"
        bind:value={draft}
        onfocus={(event) => event.currentTarget.select()}
        onblur={() => (editing = false)}
        onkeydown={(event) => {
          if (event.key === "Escape") editing = false;
        }}
      />
    </form>
  {:else}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="flex h-7 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-[0.625rem] bg-[var(--wash-1)] px-2.5 text-left shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] transition-shadow hover:shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest)]"
            aria-label="Browser address: {page.url}. Click to edit."
            onclick={beginEditing}
          >
            <Lock
              class="size-3 shrink-0 text-(--solus-text-tertiary) {parts.secure
                ? ''
                : 'opacity-50'}"
              aria-hidden="true"
            />
            <span class="text-workspace-chrome min-w-0 truncate">
              <span class="text-(--solus-text-tertiary)">{parts.scheme}</span><span
                class="text-(--solus-text-primary)">{parts.host}</span
              ><span class="text-(--solus-text-tertiary)">{parts.path}</span>
            </span>
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        class="z-[10050]"
        side="bottom"
        value="Edit browser address"
      />
    </TooltipUI.Root>
  {/if}

  <BrowserViewportChip
    viewport={statedViewport}
    {scale}
    {onViewport}
  />

  <!-- Which login the page is using, beside the size it is rendering at: both
       are facts about what is on screen, and both are settings the user changes
       from here. It shrinks rather than dropping: managing profiles is only
       reachable from this chip, and a phone pane is narrower than every rung the
       other controls disappear at. -->
  <span class="inline-flex min-w-0 shrink">
    {@render profile?.()}
  </span>

  <div class="mx-0.5 h-4 w-px shrink-0 bg-[var(--hairline-strong)]"></div>

  <!-- Chromium's own inspector on this guest, with the device emulation already
       applied. Absent where it would open on the wrong machine. -->
  {#if onOpenDevTools}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 {page.devToolsOpen
              ? 'bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] hover:text-[var(--primary)]'
              : ''}"
            aria-label="Open DevTools"
            aria-pressed={page.devToolsOpen}
            onclick={onOpenDevTools}
          >
            <SquareTerminal class="size-3.5" />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        class="z-[10050]"
        side="bottom"
        value={page.devToolsOpen
          ? "DevTools are open — close them to let Solus drive this page"
          : "Open Chromium DevTools"}
      />
    </TooltipUI.Root>
  {/if}

  {@render capture?.()}

  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 {annotating
            ? 'bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] hover:text-[var(--primary)]'
            : ''}"
          aria-pressed={annotating}
          aria-label="Annotate this page"
          onclick={onToggleAnnotating}
        >
          <Highlighter class="size-3.5" />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content
      class="z-[10050]"
      side="bottom"
      value="Annotate this page"
    />
  </TooltipUI.Root>

  <div
    class="mx-0.5 h-4 w-px shrink-0 bg-[var(--hairline-strong)] @max-[34rem]/toolbar:hidden"
  ></div>

  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 @max-[34rem]/toolbar:hidden"
          aria-label="Appearance: {page.appearance}. Switch to {nextAppearance}."
          onclick={() => onAppearance(nextAppearance)}
        >
          {#if page.appearance === "dark"}
            <Moon class="size-3.5" />
          {:else if page.appearance === "light"}
            <Sun class="size-3.5" />
          {:else}
            <SunMoon class="size-3.5" />
          {/if}
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content
      class="z-[10050]"
      side="bottom"
      value="Rendering as {page.appearance} — switch to {nextAppearance}"
    />
  </TooltipUI.Root>

  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 @max-[38rem]/toolbar:hidden"
          aria-label="Clear this browser profile's cookies and storage"
          onclick={onClearProfile}
        >
          <Eraser class="size-3.5" />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content
      class="z-[10050]"
      side="bottom"
      value="Clear browser data — signs this profile's browser pages out"
    />
  </TooltipUI.Root>

  <!-- The way out of the pane. A browser is for judging a change, not for the
       things a real browser does — a login flow, an extension, a devtools
       workflow the pane does not carry — and without this the only way to reach
       the page in a browser is to retype the port. -->
  {#if onOpenExternal}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 @max-[36rem]/toolbar:hidden"
            aria-label="Open this address in your default browser"
            onclick={onOpenExternal}
          >
            <ExternalLink class="size-3.5" />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        class="z-[10050]"
        side="bottom"
        value="Open in your default browser"
      />
    </TooltipUI.Root>
  {/if}

  <!-- Hanging off the toolbar's own bottom edge, so progress is stated in the
       chrome and never painted over the page. -->
  {#if loading}
    <div
      class="browser-loadbar pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden bg-[var(--wash-2)]"
      role="progressbar"
      aria-label="Loading the browser page"
    >
      <span class="browser-loadbar__run absolute top-0 h-0.5 bg-[var(--primary)]"
      ></span>
    </div>
  {/if}
</div>

<style>
  /* An indeterminate sweep: the page's load has no measurable progress, and a
     bar that pretended otherwise would be the lying spinner. */
  .browser-loadbar__run {
    animation: browser-loadbar-run 1.4s ease-in-out infinite;
  }

  @keyframes browser-loadbar-run {
    from {
      left: -38%;
      width: 38%;
    }
    to {
      left: 100%;
      width: 38%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .browser-loadbar__run {
      left: 0;
      width: 100%;
      animation: none;
      opacity: 0.5;
    }
  }
</style>
