<script lang="ts">
  import type { Snippet } from "svelte";
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
   *  no fill.
   *
   *  ── The record rung (`@max-[30rem]/pane`) ──
   *  A touch pointer takes the verbs at rest, so at 393px the single line was
   *  carrying an avatar, a title, an id, a context line and two buttons at
   *  once — and the title, which is what the row is read for, paid for all of
   *  it. The verbs move to a line of their own instead: `basis-full` on both
   *  ends of the swap declares that break, and whichever end renders holds the
   *  same 34px, so the row's height does not depend on whether it can be acted
   *  on. `INBOX_RECORD_ROW_HEIGHT` is that geometry counted out — the row is
   *  positioned by a virtualiser, which is told the number before the browser
   *  lays any of this out. */
  interface Props {
    row: InboxRowSpec;
    /** Rows in "Needs you" get the filled primary button; everywhere else the
     *  same verb is a cool card button, because it isn't urgent there. */
    hot?: boolean;
    selected?: boolean;
    /** Use the canonical responsive type rung for workspace list titles. */
    responsiveTitle?: boolean;
    onSelect?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
    /** Page-owned controls, such as the Tasks multi-select checkbox. */
    leading?: Snippet;
  }
  let {
    row,
    hot = false,
    selected = false,
    responsiveTitle = false,
    onSelect,
    onContextMenu,
    leading,
  }: Props = $props();

  const hasActions = $derived(!!row.primary);
  // At rest ⇢ chips + time. On hover/selection ⇢ verbs. Only one is in the DOM
  // flow at a time, and both sit at the same right edge. A touch pointer never
  // hovers, so it takes the verbs at rest — the row's actions cannot be
  // reachable on a desktop and absent on an iPad.
  const metaVisibility = $derived(
    !hasActions
      ? "flex"
      : selected
        ? "hidden"
        : "flex group-hover:hidden pointer-coarse:hidden",
  );
  const actionVisibility = $derived(
    !hasActions
      ? "hidden"
      : selected
        ? "flex"
        : "hidden group-hover:flex pointer-coarse:flex",
  );
</script>

<div
  class="text-xs group flex h-[55px] w-full items-center rounded-lg py-2 pr-3 pl-2 transition-shadow duration-150 @max-[30rem]/pane:h-[99px] @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:gap-y-1.5 @max-[30rem]/pane:py-2.5 {selected
 ? 'bg-[var(--wash-2)] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]'
 : 'hover:bg-[var(--wash-1)]'}"
  data-selected={selected}
  oncontextmenu={onContextMenu}
>
  {#if leading}{@render leading()}{/if}

  <button
    type="button"
    class="flex min-w-0 flex-1 overflow-hidden cursor-pointer items-center gap-[11px] border-0 bg-transparent p-0 text-left focus-visible:outline-none"
    onclick={onSelect}
    data-list-row
  >
    <ListAvatar person={row.actor} size={22} />

    <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span class="flex min-w-0 items-center gap-2">
        <span
          class="truncate leading-[19px] {responsiveTitle
 ? 'text-workspace-chrome'
 : ''} {row.unread
 ? 'font-medium text-foreground'
 : 'font-normal text-[color-mix(in_oklch,var(--foreground)_72%,transparent)]'}"
          title={row.title}
        >
          {row.title}
        </span>
        <span
          class="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground opacity-80"
        >
          {row.ident}
        </span>
      </span>
      <span class="truncate leading-[17px] text-muted-foreground">
        {row.context}
      </span>
    </span>
  </button>

  <!-- At rest. On the record it is line 3 rather than the right end of line 1,
       and holds the same 34px the verbs would have taken. -->
  <span
    class="{metaVisibility} ml-[11px] shrink-0 items-center gap-[9px] @max-[30rem]/pane:ml-0 @max-[30rem]/pane:h-[34px] @max-[30rem]/pane:basis-full @max-[30rem]/pane:justify-end"
  >
    {#each row.chips ?? [] as chip (chip.label)}
      <ListChip {chip} />
    {/each}
    <span
      class="w-8 shrink-0 text-right tabular-nums text-muted-foreground opacity-75"
      title={row.timeTitle}
    >
      {row.time}
    </span>
  </span>

  <!-- On hover / selection — and at rest on a touch pointer, which has no hover
       to give. That is why the record needs a line for them: on a phone this is
       not a reveal, it is simply part of the row. -->
  <span
    class="{actionVisibility} ml-[11px] shrink-0 items-center gap-1.5 @max-[30rem]/pane:ml-0 @max-[30rem]/pane:h-[34px] @max-[30rem]/pane:basis-full @max-[30rem]/pane:justify-end"
  >
    {#if row.secondary}
      <button
        type="button"
        class="flex h-[26px] cursor-pointer items-center rounded-md border-0 bg-card px-2.5 font-medium whitespace-nowrap text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-foreground @max-[30rem]/pane:h-[34px] @max-[30rem]/pane:rounded-lg @max-[30rem]/pane:px-3.5"
        onclick={row.secondary.run}
      >
        {row.secondary.label}
      </button>
    {/if}
    {#if row.primary}
      <button
        type="button"
        class="flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md border-0 px-2.5 font-medium whitespace-nowrap transition-[background-color] @max-[30rem]/pane:h-[34px] @max-[30rem]/pane:rounded-lg @max-[30rem]/pane:px-3.5 {hot
 ? 'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)]'
 : 'bg-card text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:bg-[var(--wash-2)]'}"
        onclick={row.primary.run}
      >
        {row.primary.label}
        {#if row.primary.shortcut}
          <!-- The hand, not the width: a phone has no Return key to name, and a
               tablet with a keyboard attached does. -->
          <span class="opacity-70 pointer-coarse:hidden">{row.primary.shortcut}</span>
        {/if}
      </button>
    {/if}
  </span>
</div>
