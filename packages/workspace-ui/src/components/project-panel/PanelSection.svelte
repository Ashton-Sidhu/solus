<script lang="ts">
  import type { Snippet } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Sidebar from "../ui/sidebar";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  interface Props {
    title: string;
    collapsed: boolean;
    onToggle: () => void;
    headerDetail?: string;
    /** A chip riding beside the heading — a fact the section would otherwise
     *  spend a body row stating. */
    headerBadge?: Snippet;
    headerExtra?: Snippet;
    /** The first project card reaches the window top and owns its drag band. */
    titlebar?: boolean;
    /** Every card edge is a generous entry point for resizing the whole rail. */
    onResizePointerDown?: (event: PointerEvent) => void;
    children: Snippet;
  }

  let {
    title,
    collapsed,
    onToggle,
    headerDetail,
    headerBadge,
    headerExtra,
    titlebar = false,
    onResizePointerDown,
    children,
  }: Props = $props();

  function toggle() {
    onToggle();
    requestInputFocus();
  }
</script>

<!-- Card fill matches the conversation surface it floats on, per the design
     pack — the 1px border and lift do the separating, not a tint. The card
     takes no fill of its own: the rail's SidePanel root already paints
     --solus-container-bg, which carries alpha in dark mode over a transparent
     window, so a second coat here would composite lighter than the
     conversation card beside it. A collapsed section leaves a visible gap
     rather than silently shortening. -->
<Sidebar.Group
  role="group"
  class="group/section relative min-h-0 shrink-0 gap-0 rounded-2xl border border-[color-mix(in_srgb,var(--solus-text-primary)_8%,transparent)] bg-transparent p-1.5 shadow-[0_1px_2px_-1px_rgba(0,0,0,0.05)] dark:border-[color-mix(in_srgb,var(--solus-text-primary)_11%,transparent)] dark:shadow-none {titlebar
    ? 'workspace-titlebar'
    : ''}"
>
  {#if onResizePointerDown}
    <span
      class="no-drag absolute inset-x-1 top-0 z-20 h-1 cursor-col-resize"
      aria-hidden="true"
      onpointerdown={onResizePointerDown}
    ></span>
    <span
      class="no-drag absolute inset-x-1 bottom-0 z-20 h-1 cursor-col-resize"
      aria-hidden="true"
      onpointerdown={onResizePointerDown}
    ></span>
    <span
      class="no-drag absolute inset-y-1 left-0 z-20 w-1 cursor-col-resize"
      aria-hidden="true"
      onpointerdown={onResizePointerDown}
    ></span>
    <span
      class="no-drag absolute inset-y-1 right-0 z-20 w-1 cursor-col-resize"
      aria-hidden="true"
      onpointerdown={onResizePointerDown}
    ></span>
  {/if}
  <!-- The header line declares the shelf rung once, so the title, its detail and
       whatever the section hangs beside them all step down together on a laptop
       display rather than each pinning its own size. -->
  <Sidebar.GroupLabel
    class="group/header h-auto min-h-6 justify-between gap-1 px-1.5 py-0 text-chrome-shelf"
  >
    <button
      class="flex min-h-6 min-w-0 cursor-pointer items-center border-none bg-transparent font-medium text-(--solus-text-tertiary) uppercase transition-[color,transform] duration-150 hover:text-(--solus-text-primary) active:scale-[0.996] focus-visible:rounded-md focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none {titlebar
        ? ''
        : 'flex-1'}"
      type="button"
      aria-expanded={!collapsed}
      onclick={toggle}
    >
      <span class="inline-flex min-w-0 items-center gap-1.5 truncate">
        <span class="shrink-0">{title}</span>
        {#if headerBadge}
          {@render headerBadge()}
        {/if}
        {#if headerDetail}
          <span
            class="min-w-0 truncate font-normal text-(--solus-text-tertiary) normal-case"
            aria-live="polite"
          >
            {headerDetail}
          </span>
        {/if}
      </span>
    </button>
    {#if headerExtra}
      <!-- The header's trailing value is a reading, not a label: regular weight,
           so only the heading itself carries the 500. -->
      <span
        class="min-w-0 shrink-0 font-normal text-(--solus-text-tertiary) {titlebar
          ? 'ml-auto'
          : ''}"
      >
        {@render headerExtra()}
      </span>
    {/if}
    <!-- Disclosure caret closes the header row, so the section's own control
         (+ / refresh) sits beside it rather than across the card. Redundant
         with the title button, so it stays out of the tab order. -->
    <button
      class="flex size-4 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-(--solus-text-tertiary) transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] {collapsed
 ? '-rotate-90 opacity-70'
 : 'opacity-60'}"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      onclick={toggle}
    >
      <CaretDownIcon size={14} weight="bold" />
    </button>
  </Sidebar.GroupLabel>
  {#if !collapsed}
    <div
      class="no-drag min-h-0 pt-1.5"
      transition:slide={{ duration: reduceMotion ? 0 : 180, easing: cubicOut }}
    >
      {@render children()}
    </div>
  {/if}
</Sidebar.Group>
