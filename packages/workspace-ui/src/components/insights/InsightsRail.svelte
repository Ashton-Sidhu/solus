<script lang="ts">
  import type { RailItem } from "./lib/rail";

  /**
   * The compressed listing beside an open turn: the same rows the full-width
   * list answers with, at rail width. Clicking a row moves the detail panel;
   * the row that is open stays washed so the reader keeps their place.
   */
  interface Props {
    items: RailItem[];
    /** "Turns", or the event kind when the listing is span-grained. */
    heading: string;
    /** Index of the open item, -1 when the panel shows a turn not in the list. */
    selectedIndex: number;
    onOpenItem: (item: RailItem) => void;
    emptyHint: string;
  }

  let { items, heading, selectedIndex, onOpenItem, emptyHint }: Props = $props();

  function statusLabel(status: string): string | null {
    if (status === "error") return "failed";
    if (status === "interrupted") return "stopped";
    if (status === "unknown") return "open";
    return null;
  }

  function rowBackground(status: string, selected: boolean): string {
    const base = selected ? "var(--wash-3)" : "transparent";
    if (status === "error")
      return `color-mix(in oklch, var(--failure) 9%, ${base})`;
    if (status === "interrupted")
      return `color-mix(in oklch, var(--warning) 10%, ${base})`;
    return base;
  }
</script>

<section
  class="flex min-h-0 flex-1 flex-col overflow-hidden"
  aria-label={heading}
>
  <div class="min-h-0 flex-1 overflow-y-auto" data-sb>
    {#if items.length === 0}
      <div class="flex flex-col items-center gap-2 px-4 py-16 text-center text-muted-foreground">
        <span class="text-insights-chrome">No rows match this query</span>
        <span class="text-insights-chrome">{emptyHint}</span>
      </div>
    {:else}
      {#each items as item, index (item.key)}
        {@const label = statusLabel(item.status)}
        <button
          type="button"
          class="flex w-full cursor-pointer flex-col justify-center gap-0.5 px-4 text-left transition-colors hover:bg-muted"
          style="height:3.25rem;background:{rowBackground(
            item.status,
            index === selectedIndex,
          )};box-shadow:inset 0 -0.5px 0 var(--hairline)"
          data-selected={index === selectedIndex}
          data-status={item.status}
          aria-label={label ? `${item.title}, ${label}` : item.title}
          onclick={() => onOpenItem(item)}
        >
          <span class="flex w-full min-w-0 items-center gap-2">
            <span
              class="truncate text-insights-summary leading-[1.125rem]"
              style="font-weight:{index === selectedIndex ? 500 : 400}"
              title={item.title}>{item.title}</span
            >
          </span>
          <span class="flex items-baseline gap-2 text-insights-summary leading-[1.125rem] tabular-nums text-muted-foreground">
            <span class="shrink-0">{item.timeLabel}</span>
            <span class="truncate">{item.metaLabel}</span>
          </span>
        </button>
      {/each}
      <div class="h-3"></div>
    {/if}
  </div>

</section>
