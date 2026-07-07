<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { SidebarSimpleIcon } from "phosphor-svelte";
  import { tooltip } from "../../lib/tooltip";
  import { getWindowContext } from "../../contexts/window.context.svelte";

  interface Props {
    title: string;
    side?: "left" | "right";
    open?: boolean;
    width?: number;
    minWidth?: number;
    maxWidth?: number;
    onAction?: () => void;
    actionIcon?: Component<{ size?: number }>;
    actionTooltip?: string;
    actionAriaLabel?: string;
    background?: string;
    headerTopPadding?: "default" | "compact";
    headerActions?: Snippet;
    children: Snippet;
  }

  let {
    title,
    side = "left",
    open = true,
    width,
    minWidth = 160,
    maxWidth = 400,
    onAction,
    actionIcon: ActionIcon = SidebarSimpleIcon,
    actionTooltip,
    actionAriaLabel,
    background,
    headerTopPadding = "default",
    headerActions,
    children,
  }: Props = $props();

  const panelColorVar = $derived(
    side === "right" ? "--solus-sidebar-bg-right" : "--solus-sidebar-bg-left",
  );
  const panelBg = $derived(background ?? `var(${panelColorVar})`);
  const windowCtx = getWindowContext();
</script>

<div
  class="side-panel-shell"
  class:side-panel-closed={!open}
  style:--panel-min-width="{minWidth}px"
  style:--panel-max-width="{maxWidth}px"
  style:--panel-root-width={width ? `${width - 8}px` : undefined}
  style:width={open && width ? `${width}px` : undefined}
  aria-hidden={!open}
>
  <div
    class="side-panel-root no-drag flex h-full flex-col overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--solus-container-border)_85%,transparent)] bg-(--side-panel-bg,var(--solus-sidebar-bg)) shadow-[0_1px_2px_rgba(42,38,24,0.03),0_8px_24px_-12px_rgba(42,38,24,0.08)] dark:shadow-none [contain:layout_paint]"
    style:--side-panel-bg={panelBg}
  >
    <div
      class="side-panel-header flex items-center justify-between px-4 pt-3 pb-2 flex-shrink-0"
      class:side-panel-header--mac-left={windowCtx.isMac &&
        windowCtx.viewMode === "editor" &&
        side === "left"}
      class:side-panel-header--compact-top={headerTopPadding === "compact"}
    >
      <span
        class="side-panel-title text-[0.625rem] font-semibold tracking-[0.09em] text-(--solus-text-tertiary) uppercase"
        >{title}</span
      >
      <div class="side-panel-actions inline-flex items-center gap-1">
        {#if headerActions}
          {@render headerActions()}
        {/if}
        {#if onAction}
          <button
            class="flex size-[1.625rem] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) transition-[color,background-color] duration-150 ease-in-out hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)] hover:text-(--solus-text-primary) active:bg-[color-mix(in_srgb,var(--solus-accent)_12%,transparent)]"
            use:tooltip={actionTooltip}
            onclick={onAction}
            aria-label={actionAriaLabel}
          >
            <ActionIcon size={13} />
          </button>
        {/if}
      </div>
    </div>
    {@render children()}
  </div>
</div>

<style>
  .side-panel-shell {
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

  .side-panel-header {
    min-height: var(--solus-chrome-row-h, 2.5rem);
  }

  /* Traffic lights float over this header on the editor window; the title drops
     to a second row that clears their vertical band while the actions sit
     inline beside them in the first row. Row height comes from the shared
     titlebar safe-area var so it can't drift from the other consumers. */
  .side-panel-header--mac-left {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: var(--solus-titlebar-height, 2.375rem) auto;
    align-items: center;
    padding: 0 0.75rem 0.75rem 1rem;
  }

  .side-panel-header--mac-left .side-panel-title {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .side-panel-header--mac-left .side-panel-actions {
    grid-column: 2;
    grid-row: 1;
  }

  .side-panel-header--compact-top {
    padding-top: 0.375rem;
  }
</style>
