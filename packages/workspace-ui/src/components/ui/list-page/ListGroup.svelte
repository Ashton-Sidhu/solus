<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";

  /** The 30px line that carries lifecycle state for every row beneath it —
   *  chevron, label, count, then a hairline to the right edge. Because status
   *  is the section rather than a badge, it costs no row width and sorts the
   *  page for free.
   *
   *  Empty groups are not rendered at all (the caller filters them out), so a
   *  zero never appears. The inbox reuses the same line and spends the right
   *  end on a note instead of leaving the rule bare. */
  interface Props {
    label: string;
    count: number;
    /** Both list views collapse per group unless a caller opts out. */
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
      class="text-xs font-normal uppercase {accent
 ? 'text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
 : 'text-muted-foreground'}"
    >
      {label}
    </span>
    <span class="text-xs tabular-nums text-muted-foreground opacity-70">
      {count}
    </span>
    <span class="h-px flex-1 bg-[var(--hairline)]"></span>
    {#if note}
      <span class="text-xs text-muted-foreground opacity-80">{note}</span>
    {/if}
  </svelte:element>

  {#if !collapsible || open}
    <!-- At the record rung the rows stop being lines on the page background and
         become one card with hairline seams, because a three-line record needs
         a boundary to be read as one thing. Above it the wrapper is inert and
         the list sits directly on the background, as the list-pages spec says.
    -->
    <div
      class="@max-[30rem]/pane:overflow-hidden @max-[30rem]/pane:rounded-xl @max-[30rem]/pane:bg-card @max-[30rem]/pane:shadow-[shadow:var(--elev-ring)] @max-[30rem]/pane:[&>*+*]:border-t @max-[30rem]/pane:[&>*+*]:border-[var(--hairline)]"
    >
      {@render children()}
    </div>
  {/if}
</div>
