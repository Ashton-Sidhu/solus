<script lang="ts" generics="T extends string">
  import type { Sun } from "@lucide/svelte";

  /** Content-sized segments with an outlined selection. */
  let {
    options,
    isActive,
    onSelect,
    ariaLabel,
    compact = false,
  }: {
    options: {
      value: T;
      label: string;
      short?: string;
      count?: number;
      icon?: typeof Sun;
    }[];
    isActive: (value: T) => boolean;
    onSelect: (value: T) => void;
    ariaLabel: string;
    /** Smaller toolbar geometry; keeps larger touch targets. */
    compact?: boolean;
  } = $props();
</script>

<div
  class="inline-flex w-fit shrink-0 items-center border border-border pointer-coarse:h-9 {compact
    ? 'h-6 rounded-md p-0.5'
    : 'h-8 rounded-lg p-[3px] pointer-fine:[.is-laptop-display_&]:h-7'}"
  role="group"
  aria-label={ariaLabel}
>
  {#each options as opt (opt.value)}
    {@const active = isActive(opt.value)}
    <button
      type="button"
      class="inline-flex h-full shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap border-0 text-workspace-chrome transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {compact
        ? 'rounded-sm px-1.5 font-normal pointer-coarse:px-2'
        : 'rounded-md px-2 font-medium pointer-coarse:px-2.5 pointer-fine:[.is-laptop-display_&]:px-1.5'} {active
        ? 'text-foreground'
        : 'text-muted-foreground hover:text-foreground'} {active
        ? 'bg-card shadow-[0_1px_3px_rgba(0,0,0,0.10)] ring-1 ring-border dark:bg-input/40 dark:shadow-none'
        : ''}"
      onclick={() => onSelect(opt.value)}
      aria-pressed={active}
      aria-label={opt.count !== undefined
        ? `${opt.label} (${opt.count})`
        : opt.label}
    >
      {#if opt.icon}
        <opt.icon class="size-3.5" />
      {/if}
      {#if opt.short && opt.short !== opt.label}
        <span class="@max-[32rem]:hidden">{opt.label}</span>
        <span class="hidden @max-[32rem]:inline" aria-hidden="true"
          >{opt.short}</span
        >
      {:else}
        <span>{opt.label}</span>
      {/if}
      {#if opt.count !== undefined}
        <span
          class="tabular-nums {compact
            ? 'hidden'
            : active
              ? 'text-(--solus-text-tertiary)'
              : 'opacity-60'}">{opt.count}</span
        >
      {/if}
    </button>
  {/each}
</div>
