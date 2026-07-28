<script lang="ts">
  import { Tooltip as TooltipPrimitive } from "bits-ui";
  import type { ComponentProps } from "svelte";
  import { cn, type WithoutChildrenOrChild } from "@renderer/lib/utils.js";
  import { tooltipDisplay, type TooltipValue } from "./content";
  import TooltipPortal from "./tooltip-portal.svelte";

  let {
    ref = $bindable(null),
    class: className,
    sideOffset = 6,
    side = "top",
    children,
    value,
    portalProps,
    ...restProps
  }: TooltipPrimitive.ContentProps & {
    value?: TooltipValue;
    portalProps?: WithoutChildrenOrChild<ComponentProps<typeof TooltipPortal>>;
  } = $props();

  const display = $derived(tooltipDisplay(value ?? null));
</script>

{#if children || display}
  <TooltipPortal {...portalProps}>
    <TooltipPrimitive.Content
      bind:ref
      data-slot="tooltip-content"
      {sideOffset}
      {side}
      class={cn(
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 z-[10020] inline-flex w-fit max-w-[min(24rem,calc(100vw-1rem))] origin-(--bits-tooltip-content-transform-origin) items-center gap-1.5 rounded-lg border border-(--solus-popover-border) bg-(--solus-popover-bg) px-2 py-[3px] text-xs font-medium leading-[1.25] tracking-[-0.004em] text-(--solus-text-primary) shadow-(--solus-popover-shadow) backdrop-blur-xl duration-100",
        className,
      )}
      {...restProps}
    >
      {#if display}
        <span class="min-w-0 text-pretty">{display.label}</span>
        {#if display.shortcut}
          <kbd
            class="shrink-0 rounded bg-(--solus-surface-hover) px-1 py-0.5 font-(family-name:--solus-code-font-family) text-[0.625rem] font-medium leading-none text-(--solus-text-secondary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--solus-text-primary)_6%,transparent)]"
          >
            {display.shortcut}
          </kbd>
        {/if}
      {:else}
        {@render children?.()}
      {/if}
    </TooltipPrimitive.Content>
  </TooltipPortal>
{/if}
