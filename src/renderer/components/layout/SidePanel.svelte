<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { SidebarSimpleIcon } from "phosphor-svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { getWindowContext } from "../../contexts";
  import * as Sidebar from "../ui/sidebar";

  interface Props {
    /** Omit to leave the header as a bare action row. */
    title?: string;
    side?: "left" | "right";
    open?: boolean;
    width?: number;
    /** Fill a parent-owned resizable pane instead of owning pixel geometry. */
    managedWidth?: boolean;
    /** Dissolve the panel's own surface: no gutter, no radius, no seam, so the
     *  neighbouring view reads as running under it. The panel's content
     *  supplies whatever shape it needs (the project rail floats cards on it). */
    flush?: boolean;
    isElevated?: boolean;
    minWidth?: number;
    maxWidth?: number;
    onAction?: () => void;
    actionIcon?: Component<{ size?: number }>;
    actionTooltip?: string;
    actionAriaLabel?: string;
    background?: string;
    headerActions?: Snippet;
    children: Snippet;
  }

  let {
    title,
    side = "left",
    open = true,
    width,
    managedWidth = false,
    flush = false,
    isElevated = true,
    minWidth = 160,
    maxWidth = 400,
    onAction,
    actionIcon: ActionIcon = SidebarSimpleIcon,
    actionTooltip,
    actionAriaLabel,
    background,
    headerActions,
    children,
  }: Props = $props();

  const panelColorVar = $derived(
    side === "right" ? "--solus-sidebar-bg-right" : "--solus-sidebar-bg-left",
  );
  const panelBg = $derived(background ?? `var(${panelColorVar})`);
  // Horizontal space the shell's gutter steals from a fixed-width root. A
  // managed root uses 100% because percentages already resolve against the
  // shell's content box; subtracting this again would double its right inset.
  const gutter = $derived(flush ? 0 : 8);
  const windowCtx = getWindowContext();
</script>

<div
  class="side-panel-shell"
  class:side-panel-closed={!open}
  class:side-panel-managed={managedWidth}
  class:side-panel-flush={flush}
  style:--panel-min-width="{minWidth}px"
  style:--panel-max-width="{maxWidth}px"
  style:--panel-root-width={managedWidth
    ? "100%"
    : width
      ? `${width - gutter}px`
      : undefined}
  style:width={managedWidth ? "100%" : open && width ? `${width}px` : undefined}
  aria-hidden={!open}
>
  <div
    class="side-panel-root no-drag flex h-full flex-col overflow-hidden bg-(--side-panel-bg,var(--solus-sidebar-bg)) [contain:layout_paint] {flush
      ? ''
      : 'rounded-2xl'} {flush
      ? ''
      : isElevated
        ? 'border border-[color-mix(in_srgb,var(--solus-container-border)_85%,transparent)] shadow-[0_1px_2px_rgba(42,38,24,0.03),0_8px_24px_-12px_rgba(42,38,24,0.08)] dark:shadow-none'
        : 'border border-[color-mix(in_srgb,var(--solus-text-primary)_8%,transparent)] shadow-[0_1px_2px_-1px_rgba(0,0,0,0.05)] dark:border-[color-mix(in_srgb,var(--solus-text-primary)_11%,transparent)] dark:shadow-none'}"
    style:--side-panel-bg={panelBg}
  >
    <Sidebar.Provider {open}>
      <Sidebar.Root {side} collapsible="none" class="bg-transparent">
        <!-- Skipped entirely when the panel has no chrome of its own — the
             flush project rail hands its controls to the shared chrome row. -->
        {#if title || headerActions || onAction}
          <Sidebar.Header
          class="side-panel-header flex-row items-center gap-2 {title
            ? 'justify-between'
            : 'justify-end'} {flush
            ? 'border-b border-[color-mix(in_srgb,var(--solus-container-border)_50%,transparent)] px-2 py-0'
            : 'px-4 pt-3 pb-2'} {windowCtx.isMac &&
          windowCtx.viewMode === 'editor' &&
          side === 'left'
            ? 'side-panel-header--mac-left'
            : ''} {windowCtx.isMac &&
          windowCtx.viewMode === 'editor' &&
          side === 'left' &&
          !title
            ? 'side-panel-header--untitled'
            : ''}"
        >
          {#if title}
            <span
              class="side-panel-title text-[0.625rem] font-semibold tracking-[0.09em] text-(--solus-text-tertiary) uppercase"
              >{title}</span
            >
          {/if}
          <div class="side-panel-actions inline-flex items-center gap-1">
            {#if headerActions}
              {@render headerActions()}
            {/if}
            {#if onAction}
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props: tooltipProps })}
                    <button {...tooltipProps}
                class="flex size-[var(--solus-titlebar-control-size)] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) transition-[color,background-color,transform] duration-150 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] active:bg-[color-mix(in_srgb,var(--solus-accent)_12%,transparent)]"
                onclick={onAction}
                aria-label={actionAriaLabel}
              >
                <ActionIcon size={13} />
              </button>
                  {/snippet}
                </TooltipUI.Trigger>
                <TooltipUI.Content value={actionTooltip} />
              </TooltipUI.Root>
            {/if}
          </div>
          </Sidebar.Header>
        {/if}
        <Sidebar.Content class="overflow-hidden">
          {@render children()}
        </Sidebar.Content>
      </Sidebar.Root>
    </Sidebar.Provider>
  </div>
</div>

<style>
  .side-panel-shell {
    /* The shell starts 4px from the window and its 1px border paints inward.
       Mac titlebar chrome compensates for the resulting 5px local origin. */
    --side-panel-window-inset: 5px;
    flex-shrink: 0;
    min-width: var(--panel-min-width, 160px);
    max-width: var(--panel-max-width, 400px);
    padding: 4px;
    background: transparent;
    overflow: hidden;
    visibility: visible;
    /* visibility flips instantly (0s, no delay) when reopening, so the panel is
       hit-testable/paintable the moment it starts expanding. */
    transition:
      width 240ms cubic-bezier(0.2, 0, 0, 1),
      min-width 240ms cubic-bezier(0.2, 0, 0, 1),
      padding 240ms cubic-bezier(0.2, 0, 0, 1),
      opacity 180ms cubic-bezier(0.2, 0, 0, 1),
      visibility 0s;
  }

  .side-panel-shell.side-panel-flush {
    --side-panel-window-inset: 0px;
    padding: 0;
  }

  .side-panel-shell.side-panel-managed {
    height: 100%;
    min-width: 0;
    max-width: none;
  }

  .side-panel-shell.side-panel-closed {
    width: 0;
    min-width: 0;
    padding-left: 0;
    padding-right: 0;
    opacity: 0;
    pointer-events: none;
    /* Collapsed panels leave the layout/paint/animation world entirely: spinners
       stop animating and reactive rows stop repainting once hidden. The delay
       matches the width transition so the collapse animation still plays fully
       before visibility snaps off. */
    visibility: hidden;
    transition:
      width 240ms cubic-bezier(0.2, 0, 0, 1),
      min-width 240ms cubic-bezier(0.2, 0, 0, 1),
      padding 240ms cubic-bezier(0.2, 0, 0, 1),
      opacity 180ms cubic-bezier(0.2, 0, 0, 1),
      visibility 0s 240ms;
  }

  .side-panel-root {
    /* Pinned to the open width (set from the shell) so the panel's contents
       lay out exactly once and are simply clipped by the shell's overflow
       while it animates width — instead of reflowing the whole tree (rows,
       ellipsis, footer) on every frame of the collapse/reopen. */
    width: var(--panel-root-width, 100%);
    height: 100%;
  }

  :global(.side-panel-header) {
    min-height: var(--solus-chrome-row-h, 2.5rem);
  }

  /* Traffic lights float over this header on the editor window; the title drops
     to a second row that clears their vertical band while the actions sit
     inline beside them in the first row. Row height comes from the shared
     titlebar safe-area var so it can't drift from the other consumers. */
  :global(.side-panel-header--mac-left) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: var(--solus-titlebar-height, 2.375rem) auto;
    align-items: center;
    position: relative;
    top: calc(0px - var(--side-panel-window-inset));
    margin-bottom: calc(0px - var(--side-panel-window-inset));
    padding: 0 0.75rem 0.75rem 1rem;
  }

  /* An untitled sidebar has no second-row label to clear. Keep its action in
     the traffic-light row, but do not reserve the otherwise empty lower pad. */
  :global(.side-panel-header--mac-left.side-panel-header--untitled) {
    padding-bottom: 0;
  }

  :global(.side-panel-header--mac-left .side-panel-title) {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  :global(.side-panel-header--mac-left .side-panel-actions) {
    grid-column: 2;
    grid-row: 1;
  }

</style>
