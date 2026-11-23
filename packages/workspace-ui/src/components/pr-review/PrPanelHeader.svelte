<script lang="ts">
  import * as Tooltip from "../ui/tooltip";
  import { PAGE_PILL_GROUP, PAGE_PILL_ICON_BTN } from "../../lib/page-chrome";
  import {
    Minimize2,
    Maximize2,
    ChevronLeft,
    X,
  } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import { Button } from "../ui/button";

  let {
    fullScreen,
    onToggleFullScreen,
    onClose,
    tabs,
    actions,
    menu,
  }: {
    fullScreen: boolean;
    onToggleFullScreen?: () => void;
    onClose: () => void;
    tabs: Snippet;
    actions: Snippet;
    menu: Snippet;
  } = $props();
</script>

<div class="@container/band workspace-titlebar shrink-0" data-testid="pr-panel-header">
  <div
    class="flex min-h-(--solus-chrome-row-h,2.75rem) items-center gap-x-1.5 pr-3 pl-(--band-lead) @max-[30rem]/band:grid @max-[30rem]/band:grid-cols-[auto_minmax(0,1fr)_auto] @max-[30rem]/band:gap-y-1 @max-[30rem]/band:pb-2 @max-[30rem]/band:pl-[max(0px,calc(var(--band-lead)-0.75rem))]"
    style:--band-lead={fullScreen ? "max(0.75rem, var(--solus-chrome-lead-inset, 0px))" : "0.75rem"}
  >
    <Tooltip.Root>
      <Tooltip.Trigger
        type="button"
        class="no-drag pointer-events-auto hidden size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground active:bg-[var(--wash-2)] active:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border) @max-[30rem]/band:flex [-webkit-tap-highlight-color:transparent]"
        aria-label="Back to pull requests"
        onclick={onClose}
      >
        <ChevronLeft size={19} />
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom" value="Back to pull requests (Esc)" />
    </Tooltip.Root>

    <div class="contents @max-[30rem]/band:flex">
      {@render tabs()}
    </div>
    <span class="flex-1 @max-[30rem]/band:hidden" aria-hidden="true"></span>

    {@render menu()}

    <!-- On the narrowest pane, keep the back control, view, and PR number
         on the first row. The same action groups fit on the second row. -->
    <div class="contents @max-[30rem]/band:col-span-full @max-[30rem]/band:flex @max-[30rem]/band:items-center @max-[30rem]/band:justify-end @max-[30rem]/band:gap-1.5">
      {@render actions()}
    </div>

    <div class="{PAGE_PILL_GROUP} @max-[30rem]/band:hidden" role="group" aria-label="Pull request pane controls">
      {#if onToggleFullScreen}
        <Tooltip.Root>
          <Tooltip.Trigger onclick={onToggleFullScreen}>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="icon-sm"
                class="{PAGE_PILL_ICON_BTN} cursor-pointer"
                aria-label={fullScreen ? "Back to split view" : "Expand to full screen"}
                aria-pressed={fullScreen}
              >
                {#if fullScreen}
                  <Minimize2 class="size-4" strokeWidth={1.5} aria-hidden="true" />
                {:else}
                  <Maximize2 class="size-4" strokeWidth={1.5} aria-hidden="true" />
                {/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom" value={fullScreen ? "Back to split view" : "Expand to full screen"} />
        </Tooltip.Root>
      {/if}
      <Tooltip.Root>
        <Tooltip.Trigger onclick={onClose}>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              class="{PAGE_PILL_ICON_BTN} cursor-pointer"
              aria-label="Close pull request"
            >
              <X class="size-4" strokeWidth={1.5} aria-hidden="true" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="bottom" value="Close pull request (Esc)" />
      </Tooltip.Root>
    </div>
  </div>
</div>
