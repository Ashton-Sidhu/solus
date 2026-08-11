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
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 z-[10020] inline-flex w-fit max-w-[min(24rem,calc(100vw-1rem))] origin-(--bits-tooltip-content-transform-origin) items-center gap-1 rounded-md bg-(--solus-menu-bg) px-1.5 py-[2px] text-[0.6875rem] font-medium leading-[1.3] tracking-[-0.004em] text-(--solus-text-primary) shadow-[shadow:var(--solus-menu-shadow)] duration-100",
        className,
      )}
      {...restProps}
    >
      {#if display}
        <span class="min-w-0 text-pretty">{display.label}</span>
        {#if display.shortcut}
          <kbd
            class="shrink-0 rounded-[0.1875rem] bg-(--solus-surface-hover) px-[3px] py-px font-(family-name:--solus-code-font-family) text-[0.5625rem] font-medium leading-[1.3] text-(--solus-text-secondary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--solus-text-primary)_6%,transparent)]"
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
