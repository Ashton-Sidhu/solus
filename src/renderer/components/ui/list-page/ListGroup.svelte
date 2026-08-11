<script lang="ts">
  import type { Snippet } from "svelte";
  import { CaretRightIcon } from "phosphor-svelte";

  /** The 30px line that carries lifecycle state for every row beneath it —
   *  chevron, label, count, then a hairline to the right edge. Because status
   *  is the section rather than a badge, it costs no row width and sorts the
   *  page for free.
   *
   *  Empty groups are not rendered at all (the caller filters them out), so a
   *  zero never appears. The inbox reuses the same line without the chevron and
   *  spends the right end on a note instead of leaving the rule bare. */
  interface Props {
    label: string;
    count: number;
    /** The global list collapses per group; the inbox does not. */
    collapsible?: boolean;
    open?: boolean;
    onToggle?: () => void;
    /** Right-aligned, inbox only ("oldest first"). */
    note?: string;
    /** "Needs you" only — the one group label that takes brand colour. */
    accent?: boolean;
    children: Snippet;
  }
  let {
    label,
    count,
    collapsible = true,
    open = true,
    onToggle,
    note,
    accent = false,
    children,
  }: Props = $props();
</script>

<div class="pt-1.5">
  <svelte:element
    this={collapsible ? "button" : "div"}
    type={collapsible ? "button" : undefined}
    class="flex h-[30px] w-full items-center gap-2.5 border-0 bg-transparent px-1.5 {collapsible
      ? 'cursor-pointer'
      : ''}"
    onclick={collapsible ? onToggle : undefined}
    aria-expanded={collapsible ? open : undefined}
    role={collapsible ? undefined : "presentation"}
  >
    {#if collapsible}
      <CaretRightIcon
        size={14}
        class="shrink-0 text-muted-foreground opacity-60 transition-transform duration-200 {open
          ? 'rotate-90'
          : ''}"
      />
    {/if}
    <span
      class="text-[10px] font-[450] tracking-[.09em] uppercase {accent
        ? 'text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
        : 'text-muted-foreground'}"
    >
      {label}
    </span>
    <span class="font-mono text-[11px] tabular-nums text-muted-foreground opacity-70">
      {count}
    </span>
    <span class="h-px flex-1 bg-[var(--hairline)]"></span>
    {#if note}
      <span class="text-[12px] text-muted-foreground opacity-80">{note}</span>
    {/if}
  </svelte:element>

  {#if !collapsible || open}
    {@render children()}
  {/if}
</div>
