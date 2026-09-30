<script lang="ts">
  import type { TurnFlag } from "@solus/contracts/observability-types";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import DataTableContextMenu from "./data-table/DataTableContextMenu.svelte";
  import type { RailItem } from "./lib/rail";
  import { flagChoice, flagColor, flagTitle } from "./lib/turn-flags";
  import { turnStatusBadge } from "./lib/turn-status";

  /**
   * The compressed listing beside an open turn: the same rows the full-width
   * list answers with, at rail width. Clicking a row moves the detail panel.
   *
   * A row is built the way a pull request's row is beside its review: the
   * backend's logo leads where the PR's state glyph does, then a two-by-two
   * grid — the prompt and the outcome (a failure, the cost) on line one, the
   * model and the duration on line two with the clock at its end. The open
   * row takes the same rounded wash as the open pull request.
   */
  interface Props {
    items: RailItem[];
    /** "Turns", or the event kind when the listing is span-grained. */
    heading: string;
    /** Index of the open item, -1 when the panel shows a turn not in the list. */
    selectedIndex: number;
    onOpenItem: (item: RailItem) => void;
    onOpenSession: (sessionId: string) => void;
    /** A person's marks on turns, by trace, for the chip beside the title. */
    flags?: ReadonlyMap<string, TurnFlag>;
    emptyHint: string;
    /** How far the rail has scrolled — the page folds its narrowing row
     *  into the crumb line past the top, as the pull request list does. */
    scrollTop?: number;
  }

  let {
    items,
    heading,
    selectedIndex,
    onOpenItem,
    onOpenSession,
    flags,
    emptyHint,
    scrollTop = $bindable(0),
  }: Props = $props();
  let rowMenu = $state<{ x: number; y: number; item: RailItem } | null>(null);

  let listElement = $state<HTMLElement | null>(null);

  /** Up and Down move the open row, as they move the highlight in the pull
   *  request list; focus follows, so the next press carries on from there. */
  function onListKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (items.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "ArrowDown"
        ? Math.min(selectedIndex + 1, items.length - 1)
        : Math.max(selectedIndex - 1, 0);
    const item = items[next];
    if (!item || next === selectedIndex) return;
    onOpenItem(item);
    listElement?.querySelectorAll<HTMLElement>("[data-rail-row]")[next]?.focus();
  }

  // A row opened from anywhere but its own click — the arrow keys, the panel's stepper,
  // a deep link — is brought into view.
  $effect(() => {
    const index = selectedIndex;
    if (!listElement || index < 0) return;
    listElement.querySelectorAll<HTMLElement>("[data-rail-row]")[index]?.scrollIntoView({ block: "nearest" });
  });

  function openRowMenu(event: MouseEvent, item: RailItem): void {
    event.preventDefault();
    event.stopPropagation();
    rowMenu = { x: event.clientX, y: event.clientY, item };
  }

  function rowMenuActions(item: RailItem): { label: string; run: () => void }[] {
    const actions = [
      {
        label: item.spanId ? "Open in waterfall" : "Open turn",
        run: () => onOpenItem(item),
      },
    ];
    const sessionId = item.sessionId;
    if (sessionId) {
      actions.push({
        label: "Open session",
        run: () => onOpenSession(sessionId),
      });
    }
    return actions;
  }
</script>

{#snippet dot()}
  <span class="shrink-0 text-muted-foreground/50" aria-hidden="true">·</span>
{/snippet}

<section
  class="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
  aria-label={heading}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="-mx-2 min-h-0 flex-1 overflow-y-auto px-2"
    data-sb
    bind:this={listElement}
    onkeydown={onListKeydown}
    onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
  >
    {#if items.length === 0}
      <div class="flex flex-col items-center gap-2 px-4 py-16 text-center text-muted-foreground">
        <span class="text-sm">No rows match this query</span>
        <span class="text-xs">{emptyHint}</span>
      </div>
    {:else}
      {#each items as item, index (item.key)}
        {@const selected = index === selectedIndex}
        {@const badge = turnStatusBadge(item.status)}
        {@const flag = item.spanId ? undefined : flags?.get(item.traceId)}
        <button
          type="button"
          class="@container/turn-row grid h-[76px] w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg border-0 px-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary) {selected
            ? 'bg-[var(--wash-2)]'
            : 'bg-transparent hover:bg-[var(--wash-1)]'} {item.mark ? 'grid-cols-[auto_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)]'}"
          data-rail-row
          data-selected={selected}
          data-status={item.status}
          aria-current={selected ? "true" : undefined}
          aria-label={badge ? `${item.title}, ${badge.label}` : item.title}
          onclick={() => onOpenItem(item)}
          oncontextmenu={(event) => openRowMenu(event, item)}
        >
          {#if item.mark}
            <span class="flex size-4 items-center justify-center" title={item.modelLabel ?? undefined}>
              <ProviderMark mark={item.mark} size={14} />
            </span>
          {/if}

          <span class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm font-medium text-foreground" title={item.title}
                >{item.title}</span
              >
              {#if flag}
                {@const choice = flagChoice(flag.kind)}
                <span
                  class="flex shrink-0 items-center"
                  style="color:{flagColor(flag.kind)}"
                  role="img"
                  aria-label={choice.label}
                  title={flagTitle(flag.kind, flag.note)}
                >
                  <choice.icon size={13} aria-hidden="true" />
                </span>
              {/if}
            </span>

            <!-- The outcome, right-aligned so it reads as a column down the
                 rail: a failure first, then what the turn cost. -->
            <span class="flex shrink-0 items-center justify-end gap-2 text-xs tabular-nums">
              {#if badge}
                <span
                  class="flex items-center"
                  style="color:{badge.color}"
                  role="img"
                  aria-label={badge.label}
                  title={badge.label}
                >
                  <badge.icon size={14} aria-hidden="true" />
                </span>
              {/if}
              {#if item.costLabel}
                <span class="whitespace-nowrap text-foreground">{item.costLabel}</span>
              {/if}
            </span>

            <span
              class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
            >
              {#if item.modelLabel}
                <span class="shrink-0">{item.modelLabel}</span>
                {@render dot()}
              {/if}
              <span class="shrink-0 tabular-nums">{item.durationLabel}</span>
            </span>

            <span
              class="hidden justify-self-end text-[11px] whitespace-nowrap text-muted-foreground tabular-nums @min-[16rem]/turn-row:inline"
            >
              {item.timeLabel}
            </span>
          </span>
        </button>
      {/each}
      <div class="h-3"></div>
    {/if}
  </div>

  {#if rowMenu}
    {@const menu = rowMenu}
    <DataTableContextMenu
      x={menu.x}
      y={menu.y}
      insightsId={menu.item.traceId}
      actions={rowMenuActions(menu.item)}
      onClose={() => (rowMenu = null)}
    />
  {/if}

</section>
