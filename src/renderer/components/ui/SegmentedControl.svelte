<script lang="ts" generics="T extends string">
  /** Recessed-track segmented filter: quiet labels, the active segment lifts
   *  out of the track on its own surface. `isActive` is a callback so
   *  multi-select filters (e.g. Plans' status set) work alongside
   *  single-select. */
  interface Props {
    options: { value: T; label: string; short?: string; count?: number }[];
    isActive: (value: T) => boolean;
    onSelect: (value: T) => void;
    ariaLabel: string;
    /** Tighter command-bar spacing for narrow docked sidebars. */
    compact?: boolean;
    /** `pill` is the library-page default (round track, 11px labels). `bar` is
     *  the 32px command-bar form: a squared track whose active segment lifts on
     *  the page surface, sized to sit level with a 32px search field. */
    variant?: "pill" | "bar";
  }
  let {
    options,
    isActive,
    onSelect,
    ariaLabel,
    variant = "pill",
    compact = false,
  }: Props = $props();

  const bar = $derived(variant === "bar");
  const segBtnClass = $derived(
    bar && compact
      ? "inline-flex h-full cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border-0 px-1.5 text-xs transition-[background-color,color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      : bar
      ? "inline-flex h-full cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border-0 px-2.5 text-[0.8125rem] transition-[background-color,color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] @max-[16rem]:gap-1 @max-[16rem]:px-1.5 @max-[16rem]:text-xs"
      : "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border-0 px-2.5 py-1 text-xs font-medium transition-[background-color,color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] [@media(pointer:coarse)]:min-h-8 [@media(pointer:coarse)]:px-3",
  );
  const segActiveClass = $derived(
    bar
      ? "bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-none dark:ring-1 dark:ring-white/10"
      : "bg-(--solus-input-pill-bg) text-(--solus-text-primary) shadow-[0_0.0625rem_0.1875rem_rgba(0,0,0,0.08)] ring-1 ring-black/5 dark:shadow-none dark:ring-white/10",
  );
  const segIdleClass = $derived(
    bar
      ? "bg-transparent font-normal text-muted-foreground hover:text-foreground"
      : "bg-transparent text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)",
  );
</script>

<div
  class="flex shrink-0 items-center gap-0.5 bg-(--solus-surface-hover) p-0.5 {bar
    ? 'h-8 rounded-lg'
    : 'rounded-full'}"
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
          class="tabular-nums {bar && compact
            ? 'hidden'
            : bar
            ? 'font-mono text-xs opacity-65 @max-[16rem]:hidden'
            : active
              ? 'text-(--solus-text-tertiary)'
              : 'opacity-60'}">{opt.count}</span
        >
      {/if}
    </button>
  {/each}
</div>
