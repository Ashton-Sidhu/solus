<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { SidebarSimpleIcon } from "phosphor-svelte";
  import { tooltip } from "../../lib/tooltip";

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
    headerActions,
    children,
  }: Props = $props();

  const panelColorVar = $derived(
    side === "right" ? "--solus-sidebar-bg-right" : "--solus-sidebar-bg-left",
  );
  const panelBg = $derived(background ?? `var(${panelColorVar})`);
</script>

<div
  class="side-panel-shell"
  class:side-panel-closed={!open}
  style:--panel-min-width="{minWidth}px"
  style:--panel-max-width="{maxWidth}px"
  style:--panel-root-width={width ? `${width - 16}px` : undefined}
  style:width={open && width ? `${width}px` : undefined}
  aria-hidden={!open}
>
  <div
    class="side-panel-root no-drag flex h-full flex-col overflow-hidden rounded-2xl border border-(--solus-container-border) bg-(--side-panel-bg,var(--solus-sidebar-bg)) [contain:layout_paint]"
    style:--side-panel-bg={panelBg}
  >
    <div
      class="side-panel-header flex items-center justify-between px-4 pt-3 pb-2 flex-shrink-0"
    >
      <span class="text-[0.625rem] font-semibold tracking-[0.06em] text-(--solus-text-tertiary) uppercase opacity-80">{title}</span>
      <div class="inline-flex items-center gap-1">
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
    padding: 8px;
    background: transparent;
    overflow: hidden;
    transition:
      width 240ms cubic-bezier(0.2, 0, 0, 1),
      min-width 240ms cubic-bezier(0.2, 0, 0, 1),
      padding 240ms cubic-bezier(0.2, 0, 0, 1),
      opacity 180ms cubic-bezier(0.2, 0, 0, 1);
  }

  .side-panel-shell.side-panel-closed {
    width: 0;
    min-width: 0;
    padding-left: 0;
    padding-right: 0;
    opacity: 0;
    pointer-events: none;
  }

  .side-panel-root {
    /* Pinned to the open width (set from the shell) so the panel's contents
       lay out exactly once and are simply clipped by the shell's overflow
       while it animates width — instead of reflowing the whole tree (rows,
       ellipsis, footer) on every frame of the collapse/reopen. */
    width: var(--panel-root-width, 100%);
    height: 100%;
  }
</style>
