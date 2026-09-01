<script lang="ts" generics="T extends string">
  /** Recessed-track segmented filter: quiet labels, the active segment lifts on
   *  a pill with a hairline ring + soft shadow. `isActive` is a callback so
   *  multi-select filters (e.g. Plans' status set) work alongside single-select. */
  interface Props {
    options: { value: T; label: string; short?: string; count?: number }[];
    isActive: (value: T) => boolean;
    onSelect: (value: T) => void;
    ariaLabel: string;
  }
  let { options, isActive, onSelect, ariaLabel }: Props = $props();

  const segBtnClass =
    "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border-0 px-2.5 py-1 text-[0.6875rem] font-medium transition-[background-color,color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] [@media(pointer:coarse)]:min-h-8 [@media(pointer:coarse)]:px-3";
  const segActiveClass =
    "bg-(--solus-input-pill-bg) text-(--solus-text-primary) shadow-[0_0.0625rem_0.1875rem_rgba(0,0,0,0.08)] ring-1 ring-black/5 dark:shadow-none dark:ring-white/10";
  const segIdleClass =
    "bg-transparent text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)";
</script>

<div
  class="flex shrink-0 items-center gap-0.5 rounded-full bg-(--solus-surface-hover) p-0.5"
  role="group"
  aria-label={ariaLabel}
>
  {#each options as opt (opt.value)}
    {@const active = isActive(opt.value)}
    <button
      type="button"
      class="{segBtnClass} {active ? segActiveClass : segIdleClass}"
      onclick={() => onSelect(opt.value)}
      aria-pressed={active}
      aria-label={opt.count !== undefined
        ? `${opt.label} (${opt.count})`
        : opt.label}
    >
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
          class="tabular-nums {active
            ? 'text-(--solus-text-tertiary)'
            : 'opacity-60'}">{opt.count}</span
        >
      {/if}
    </button>
  {/each}
</div>
