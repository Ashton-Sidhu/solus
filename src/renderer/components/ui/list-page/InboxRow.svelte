<script lang="ts">
  import ListAvatar from "./ListAvatar.svelte";
  import ListChip from "./ListChip.svelte";
  import type { InboxRowSpec } from "./list-page";

  /** One line of the inbox: what happened, then why it is on your list. The
   *  right end is a swap — metadata at rest, verbs on hover or selection — so
   *  the row never changes height and the buttons never sit there greyed out.
   *
   *  The swap is pure CSS off the wrapper's `group`, with `selected` pinning it
   *  open; hover state in `$state` would re-render every row in the list on
   *  every pointer move. Unread is weight and colour on the title only: no dot,
   *  no fill. */
  interface Props {
    row: InboxRowSpec;
    /** Rows in "Needs you" get the filled primary button; everywhere else the
     *  same verb is a cool card button, because it isn't urgent there. */
    hot?: boolean;
    selected?: boolean;
    onSelect?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
  }
  let {
    row,
    hot = false,
    selected = false,
    onSelect,
    onContextMenu,
  }: Props = $props();

  const hasActions = $derived(!!row.primary);
  // At rest ⇢ chips + time. On hover/selection ⇢ verbs. Only one is in the DOM
  // flow at a time, and both sit at the same right edge.
  const metaVisibility = $derived(
    !hasActions ? "flex" : selected ? "hidden" : "flex group-hover:hidden",
  );
  const actionVisibility = $derived(
    !hasActions ? "hidden" : selected ? "flex" : "hidden group-hover:flex",
  );
</script>

<div
  class="group flex h-[55px] w-full items-center gap-[11px] rounded-lg py-2 pr-3 pl-2 transition-shadow duration-150 {selected
 ? 'bg-[var(--wash-2)] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]'
 : 'hover:bg-[var(--wash-1)]'}"
  data-selected={selected}
  oncontextmenu={onContextMenu}
>
  <button
    type="button"
    class="flex min-w-0 flex-1 cursor-pointer items-center gap-[11px] border-0 bg-transparent p-0 text-left focus-visible:outline-none"
    onclick={onSelect}
    data-list-row
  >
    <ListAvatar person={row.actor} size={22} />

    <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span class="flex min-w-0 items-center gap-2">
        <span
          class="truncate text-[13px] leading-[19px] {row.unread
 ? 'font-medium text-foreground'
 : 'font-normal text-[color-mix(in_oklch,var(--foreground)_72%,transparent)]'}"
          title={row.title}
        >
          {row.title}
        </span>
        <span
          class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground opacity-80"
        >
          {row.ident}
        </span>
      </span>
      <span class="truncate text-[12px] leading-[17px] text-muted-foreground">
        {row.context}
      </span>
    </span>
  </button>

  <!-- At rest -->
  <span class="{metaVisibility} shrink-0 items-center gap-[9px]">
    {#each row.chips ?? [] as chip (chip.label)}
      <ListChip {chip} />
    {/each}
    <span
      class="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground opacity-75"
      title={row.timeTitle}
    >
      {row.time}
    </span>
  </span>

  <!-- On hover / selection -->
  <span class="{actionVisibility} shrink-0 items-center gap-1.5">
    {#if row.secondary}
      <button
        type="button"
        class="flex h-[26px] cursor-pointer items-center rounded-md border-0 bg-card px-2.5 text-[12px] font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-foreground"
        onclick={row.secondary.run}
      >
        {row.secondary.label}
      </button>
    {/if}
    {#if row.primary}
      <button
        type="button"
        class="flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md border-0 px-2.5 text-[12px] font-medium transition-[background-color] {hot
 ? 'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)]'
 : 'bg-card text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:bg-[var(--wash-2)]'}"
        onclick={row.primary.run}
      >
        {row.primary.label}
        {#if row.primary.shortcut}
          <span class="font-mono text-[11px] opacity-70">{row.primary.shortcut}</span>
        {/if}
      </button>
    {/if}
  </span>
</div>
