<script lang="ts">
  import { Bot as AgentsIcon, FileDiff as ChangesIcon, GitPullRequest as PullRequestIcon, Layers as ItemsIcon } from "@lucide/svelte";
  import LineCounts from "./LineCounts.svelte";
  import type { OverviewKind, OverviewTile } from "./lib/overview-view";

  /**
   * The scope's four numbers, in one row at every width
   * (docs/plans/session-artifacts.md). Each tile names its kind over its
   * number, and says beside the number how its rows stand. A tile is also the
   * kind filter: the accent thumb glides to the one selected and leaves when
   * it clears.
   */
  interface Props {
    tiles: readonly OverviewTile[];
    /** The kind the cards are narrowed to. Null shows every kind. */
    selected: OverviewKind | null;
    onSelect: (kind: OverviewKind | null) => void;
  }
  let { tiles, selected, onSelect }: Props = $props();

  const selectedIndex = $derived(tiles.findIndex((tile) => tile.kind === selected));
  /** Where the thumb last was, so it fades in place when the filter clears. */
  let lastIndex = $state(0);

  function toggle(tile: OverviewTile, index: number) {
    lastIndex = index;
    onSelect(tile.kind === selected ? null : tile.kind);
  }

  const TILE_ICON = { changes: ChangesIcon, agents: AgentsIcon, "pull-requests": PullRequestIcon, items: ItemsIcon };
</script>

<div class="relative grid grid-cols-4 p-1" data-testid="artifacts-tiles">
  <span
    aria-hidden="true"
    class="pointer-events-none absolute inset-y-1 w-[calc((100%-0.5rem)/4)] rounded-xl bg-[color-mix(in_srgb,var(--solus-accent)_9%,transparent)] shadow-[0_0_0_.5px_color-mix(in_srgb,var(--solus-accent)_38%,transparent)] transition-[left,opacity] duration-[380ms] ease-(--ease-premium) motion-reduce:transition-none {selectedIndex ===
    -1
      ? 'opacity-0'
      : 'opacity-100'}"
    style:left="calc(0.25rem + (100% - 0.5rem) / 4 * {selectedIndex === -1 ? lastIndex : selectedIndex})"
  ></span>
  {#each tiles as tile, index (tile.kind)}
    {@const on = tile.kind === selected}
    {@const Icon = TILE_ICON[tile.kind]}
    <button
      type="button"
      aria-pressed={on}
      aria-label="{tile.label}: {tile.count}{tile.detail ? `, ${tile.detail}` : ''}"
      disabled={tile.count === 0 && !on}
      class="relative flex min-w-0 cursor-pointer flex-col gap-1 overflow-hidden rounded-xl border-0 bg-transparent px-3 py-2.5 text-left transition-colors duration-(--duration-base) ease-(--ease-premium) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) disabled:cursor-default disabled:opacity-45 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:py-2 {on
        ? ''
        : 'enabled:hover:bg-[var(--wash-1)]'}"
      data-testid="artifacts-tile"
      data-kind={tile.kind}
      onclick={() => toggle(tile, index)}
    >
      <!-- The kind's name. On a narrow pane the short name stands alone: the icon gives its room to it. -->
      <span
        class="flex min-w-0 items-center gap-1.5 text-xs transition-colors duration-200 ease-(--ease-premium) {on
          ? 'text-[color-mix(in_srgb,var(--solus-accent)_82%,var(--foreground))]'
          : 'text-muted-foreground'}"
      >
        <Icon size={14} strokeWidth={1.75} class="shrink-0 @max-[30rem]/pane:hidden" />
        <span class="min-w-0 truncate @max-[30rem]/pane:hidden">{tile.label}</span>
        <span class="hidden min-w-0 truncate @max-[30rem]/pane:block">{tile.shortLabel}</span>
      </span>
      <span class="flex min-w-0 items-baseline gap-2">
        <span class="text-[17px] leading-5 font-semibold tracking-[-0.014em] tabular-nums text-foreground">{tile.count}</span>
        <!-- How the rows stand. On a narrow pane the number stands alone: the cards below say the rest. -->
        {#if tile.lines}
          <LineCounts additions={tile.lines.additions} deletions={tile.lines.deletions} class="min-w-0 truncate @max-[30rem]/pane:hidden" />
        {:else if tile.detail}
          <span class="min-w-0 truncate text-xs tabular-nums text-muted-foreground @max-[30rem]/pane:hidden">{tile.detail}</span>
        {/if}
      </span>
    </button>
  {/each}
</div>
