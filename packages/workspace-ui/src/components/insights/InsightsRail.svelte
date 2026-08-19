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

  const statusLabels: Record<string, string> = {
    error: "failed",
    interrupted: "stopped",
    unknown: "open",
  };
</script>

<section
  class="flex min-h-0 flex-1 flex-col overflow-hidden"
  aria-label={heading}
>
  <header
    class="flex h-9 shrink-0 items-center gap-2 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
  >
    <h2 class="text-[0.8125rem] font-semibold">{heading}</h2>
    <span class="text-[0.6875rem] tabular-nums text-muted-foreground">{items.length}</span>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto" data-sb>
    {#if items.length === 0}
      <div class="flex flex-col items-center gap-2 px-4 py-16 text-center text-muted-foreground">
        <span class="text-xs">No rows match this query</span>
        <span class="text-[0.625rem]">{emptyHint}</span>
      </div>
    {:else}
      {#each items as item, index (item.key)}
        <button
          type="button"
          class="flex w-full cursor-pointer flex-col justify-center gap-0.5 px-4 text-left transition-colors hover:bg-muted"
          style="height:3.25rem;background:{index === selectedIndex
            ? 'var(--wash-3)'
            : 'transparent'};box-shadow:inset 0 -0.5px 0 var(--hairline)"
          data-selected={index === selectedIndex}
          onclick={() => onOpenItem(item)}
        >
          <span class="flex w-full min-w-0 items-center gap-2">
            <span
              class="truncate text-[0.8125rem]"
              style="font-weight:{index === selectedIndex ? 500 : 400}"
              title={item.title}>{item.title}</span
            >
            {#if item.status !== "ok"}
              <span
                class="shrink-0 text-[0.625rem] font-medium uppercase"
                style="color:{item.status === 'error' ? 'var(--failure)' : 'var(--warning)'}"
                >{statusLabels[item.status] ?? item.status}</span
              >
            {/if}
          </span>
          <span class="flex items-baseline gap-2 text-xs tabular-nums text-muted-foreground">
            <span class="shrink-0">{item.timeLabel}</span>
            <span class="truncate">{item.metaLabel}</span>
          </span>
        </button>
      {/each}
      <div class="h-3"></div>
    {/if}
  </div>
</section>
