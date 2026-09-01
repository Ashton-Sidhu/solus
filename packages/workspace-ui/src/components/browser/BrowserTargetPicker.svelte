<script lang="ts">
  import {
    ChevronLeft,
    ChevronRight,
    Globe2,
    RefreshCw,
    RotateCw,
  } from "@lucide/svelte";
  import type { BrowserDiscoveredTarget } from "@solus/contracts/browser-types";
  import { Skeleton } from "../ui/skeleton";
  import * as TooltipUI from "../ui/tooltip";
  import { navigableAddress } from "./lib/address";

  /**
   * Where a page is created: the pane's empty state, and the `+` in the page
   * strip once one is open.
   *
   * Solus does not start dev servers — the boot layer waits for the integrated
   * terminal — so discovery produces *offers*, never actions. The list below is
   * what the host found listening; the field is for anything it could not see.
   */

  interface Props {
    targets: BrowserDiscoveredTarget[];
    loading: boolean;
    onRefresh: () => void;
    onOpen: (target: BrowserDiscoveredTarget) => void;
    onOpenUrl: (url: string) => void;
    /** The address being opened, while the page loads offscreen behind this
     *  list. The picker stays up for that whole load, so without it a chosen
     *  offer looks like a click that did nothing. */
    openingUrl?: string | null;
    /** Set when a page is already open behind this: choosing one is then
     *  optional, and leaving has to be possible. */
    onCancel?: (() => void) | undefined;
  }

  let {
    targets,
    loading,
    onRefresh,
    onOpen,
    onOpenUrl,
    openingUrl = null,
    onCancel,
  }: Props = $props();

  let manualUrl = $state("");

  function submitManual(event: SubmitEvent) {
    event.preventDefault();
    if (openingUrl) return;
    const url = navigableAddress(manualUrl);
    if (!url) return;
    manualUrl = "";
    onOpenUrl(url);
  }

</script>

<div
  class="text-workspace-chrome flex min-h-0 flex-1 flex-col"
  onkeydown={(event) => {
    if (event.key === "Escape") onCancel?.();
  }}
  role="presentation"
>
  <!-- A new page is still a browser page. Keep the address in the same chrome
       band as an open page instead of demoting it into the empty-state card. -->
  <form
    class="@container/toolbar relative flex h-[2.625rem] w-full shrink-0 items-center gap-1.5 border-b border-[var(--hairline)] pr-2 pl-1.5"
    onsubmit={submitManual}
  >
    <button
      type="button"
      class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) opacity-30"
      disabled
      aria-label="Back"
    >
      <ChevronLeft class="size-3.5" />
    </button>
    <button
      type="button"
      class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) opacity-30"
      disabled
      aria-label="Forward"
    >
      <ChevronRight class="size-3.5" />
    </button>
    <button
      type="button"
      class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) opacity-30"
      disabled
      aria-label="Reload"
    >
      <RotateCw class="size-3.5" />
    </button>

    <div
      class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[0.625rem] bg-[var(--wash-1)] px-2.5 shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] focus-within:shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest)]"
    >
      {#if openingUrl}
        <RotateCw
          class="size-3 shrink-0 animate-spin text-(--solus-text-tertiary)"
          aria-hidden="true"
        />
      {:else}
        <Globe2
          class="size-3 shrink-0 text-(--solus-text-tertiary)"
          aria-hidden="true"
        />
      {/if}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="text-workspace-chrome min-w-0 flex-1 bg-transparent text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary)"
        placeholder={openingUrl ? `Opening ${openingUrl}…` : "Enter a URL"}
        disabled={openingUrl !== null}
        bind:value={manualUrl}
        spellcheck="false"
        autocomplete="off"
        autofocus
        aria-label="Browser address"
      />
    </div>
  </form>

  <div class="flex min-h-0 flex-1 items-center justify-center px-6">
    <div class="w-full max-w-md">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-(--solus-text-primary)">
          Running dev servers
        </h2>
        {#if onCancel}
          <button
            type="button"
            class="ml-auto mr-1 rounded-md px-2 py-0.5 text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
            onclick={onCancel}
          >
            Cancel
          </button>
        {/if}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex size-6 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
                aria-label="Scan again"
                onclick={onRefresh}
              >
                <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content
            class="z-[10050]"
            side="bottom"
            value="Scan again"
          />
        </TooltipUI.Root>
      </div>

      {#if targets.length}
        <ul class="flex flex-col gap-1">
          {#each targets as target (target.url)}
            {@const opening = openingUrl === target.url}
            <li>
              <button
                type="button"
                class="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-(--solus-container-border) px-3 py-2 text-left transition-colors hover:bg-(--solus-surface-hover) disabled:hover:bg-transparent"
                disabled={openingUrl !== null}
                onclick={() => onOpen(target)}
              >
                <span
                  class="min-w-0 flex-1 truncate text-(--solus-text-primary)"
                >
                  {target.title ?? target.url}
                </span>
                <!-- The page loads offscreen before it replaces this list, so
                     without this the click has no answer at all until the whole
                     page has painted. -->
                {#if opening}
                  <RotateCw
                    class="size-3 shrink-0 animate-spin text-(--solus-text-tertiary)"
                    aria-hidden="true"
                  />
                  <span class="shrink-0 text-(--solus-text-tertiary)">
                    Opening…
                  </span>
                {:else}
                  {#if target.branch}
                    <span class="shrink-0 truncate text-(--solus-text-tertiary)">
                      {target.branch}
                    </span>
                  {/if}
                  <span
                    class="shrink-0 text-(--solus-text-tertiary) tabular-nums"
                  >
                    :{target.port}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {:else if loading}
        <!-- A scan in flight is not an empty result. Saying "nothing is
             listening" before the host has answered tells the user to go start
             a server they may already be running. -->
        <ul
          class="flex flex-col gap-3 py-2"
          aria-label="Scanning for dev servers"
        >
          {#each [0, 90, 180] as delay (delay)}
            <li class="flex items-center gap-2" aria-hidden="true">
              <Skeleton
                class="h-[0.625rem] min-w-0 flex-1 rounded-[0.1875rem]"
                style="animation-delay:{delay}ms"
              />
              <Skeleton
                class="h-[0.625rem] w-14 shrink-0 rounded-[0.1875rem]"
                style="animation-delay:{delay}ms"
              />
              <Skeleton
                class="h-[0.625rem] w-8 shrink-0 rounded-[0.1875rem]"
                style="animation-delay:{delay}ms"
              />
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-(--solus-text-tertiary)">
          Nothing is listening. Start your dev server in a terminal — Solus
          finds it and offers it here.
        </p>
      {/if}
    </div>
  </div>
</div>
