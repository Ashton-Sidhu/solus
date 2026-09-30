<script lang="ts">
  import type { Snippet } from "svelte";
  import { Plus as PlusIcon } from "@lucide/svelte";
  import type { NavPage } from "../../../lib/page-nav";
  import PageCrumbLine from "./PageCrumbLine.svelte";

  /**
   * The shell every page-level list is built in ("List pages" spec, Part A).
   * Two fixed rows over one scroll region, each row with a single job:
   *
   *   Row 1 — the page title. Answers *where am I*, holds nothing that filters.
   *   Row 2 — search, filters (the project scope among them), sort, view, and
   *           the page's one creating action.
   *           Answers *what am I looking at*, holds nothing that navigates.
   *
   * The search field is always on screen no matter how long the list is. Keys
   * are not legended along the bottom; each one is stated on the control it
   * drives, so the shortcut is learned where it is used.
   *
   * The content column uses the same responsive measure and gutters as the
   * Automations page. The list sits directly on the page background; it is
   * never put in a card.
   *
   * Everything page-specific — which columns, which groups, which chips, which
   * filters, which verbs — is passed in. A person moving between Tasks and Pull
   * requests should never have to relearn where anything is.
   */
  interface Props {
    /** Which page the title names. */
    page: NavPage;
    /** Overrides the page's own name in the title. */
    title?: string;
    onRefresh?: () => void;
    refreshing?: boolean;
    /** When the page last finished loading — the refresh chip's own label. */
    syncedAt?: number | null;
    /** The rows on screen came off a cached copy, not from the provider. */
    syncFromCache?: boolean;
    /** The page's one creating action. */
    primaryAction?: { label: string; shortcut?: string; run: () => void };
    /** Move the page between the leading pane and the companion beside it.
     *  Absent where there is no pane to move to, such as an inline mobile page. */
    onMoveAcross?: () => void;
    /** Which way `onMoveAcross` sends the page. */
    isLeading?: boolean;
    onClose?: () => void;
    /** Page-specific chips at the far end of the crumb line — provider
     *  identity, a bulk-selection count. Never anything that filters. */
    actions?: Snippet;
    /** The narrowing row: search, filter chips, sort. Fixed, under the crumb. */
    filters?: Snippet;
    /** `filters` is a 32px toolbar (a search card and menu buttons) rather than
     *  the 28px chip band, so the row is stated at that height whether or not
     *  the list is split — the same row the split rail already draws. */
    toolbarFilters?: boolean;
    /** The scroll region. */
    children: Snippet;
    scrollEl?: HTMLDivElement | null;
    /** The child (for example a virtual list) owns vertical scrolling. */
    contentOwnsScroll?: boolean;
    contentHeight?: number;
    /** The list is docked beside an open detail panel: it drops the reading
     *  measure, tightens the gutters and the head, and gives up the crumb,
     *  because the column is now a place to navigate from rather than the page
     *  you are reading. */
    split?: boolean;
    /** Removes the crumb line when the host surface already owns those
     *  controls. The narrowing row still clears the frame titlebar. */
    hideHeader?: boolean;
    /** The crumb line is a chrome row — the same `--solus-chrome-row-h` band
     *  the detail panel beside the list draws — so the two top rows sit level
     *  across the split. */
    chromeHead?: boolean;
    /** The narrowing row may wrap: under 32rem of the list's own width the
     *  search takes a line of its own and the menus sit under it.
     *  Measured on the list, not the pane, so it holds beside an open
     *  detail panel. */
    wrapFilters?: boolean;
    /** The list has scrolled past the narrowing row: the row folds away and
     *  `condensedCrumbs` carries its filters on the crumb line instead. The
     *  row is hidden, not unmounted, so its controls keep their state. */
    condensed?: boolean;
    condensedCrumbs?: Snippet;
  }
  let {
    page,
    title,
    onRefresh,
    refreshing = false,
    syncedAt = null,
    syncFromCache = false,
    primaryAction,
    onMoveAcross,
    isLeading = true,
    onClose,
    actions,
    filters,
    toolbarFilters = false,
    children,
    scrollEl = $bindable(null),
    contentOwnsScroll = false,
    contentHeight = $bindable(0),
    split = false,
    hideHeader = false,
    chromeHead = false,
    wrapFilters = false,
    condensed = false,
    condensedCrumbs,
  }: Props = $props();

  // The head's own measure. The type on the head comes from the shared chrome
  // rung, never from this boundary.
  const headPad = $derived(
    split
      ? "pt-[26px]"
      : "pt-[42px]",
  );
</script>

<!-- `listpage` is declared only where the narrowing row wraps by it: a
     container is also the containing block for `position: fixed` children,
     and the pages that do not wrap have no reason to pay that. -->
<div
  class="text-chrome-dense relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground {wrapFilters
    ? '@container/listpage'
    : ''}"
>
  <div
    class="mx-auto flex min-h-0 w-full flex-1 flex-col {split
      ? 'px-[18px]'
      : 'max-w-[72rem] px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4'} {hideHeader
      ? split
        ? 'pt-[max(26px,var(--solus-page-top-inset,0px))]'
        : 'pt-[max(42px,var(--solus-page-top-inset,0px))]'
      : ''}"
  >
    <!-- ── Row 1: the page title, and the controls that act on the window ── -->
    {#if !hideHeader}
      <!-- The row is exactly its tallest control, stated rather than inferred:
           the loading silhouette reserves the same box, so the list under it
           does not drop when the real page arrives.

           At the record rung the tallest control is the 44px drawer button. -->
      <div
        class={chromeHead
          ? "workspace-titlebar mb-2 flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center pl-[max(0px,calc(var(--solus-chrome-lead-inset,0px)-18px))]"
          : `workspace-titlebar box-content flex h-[31px] shrink-0 items-center pointer-coarse:h-9 @max-[30rem]/pane:h-11! @max-[30rem]/pane:pb-2.5! ${headPad} ${split
 ? 'pb-[11px]'
 : 'pb-[13px]'}`}
      >
        <PageCrumbLine
          {page}
          pageLabel={title}
          trail={condensed ? condensedCrumbs : undefined}
          {actions}
          {onRefresh}
          {refreshing}
          {syncedAt}
          {syncFromCache}
          {onMoveAcross}
          {isLeading}
          {onClose}
        />
      </div>
    {/if}

    <!-- ── Row 2: everything that narrows, and the one action that creates ── -->
    {#if filters || primaryAction}
      <!-- At the record rung this wraps into two lines rather than running off
           the pane: the one creating action keeps the first line,
           and the filter bar takes a full-width second, where it splits itself
           into a search field and a scrolling chip row. -->
      <div
        class="box-content shrink-0 items-center gap-2 {condensed && !hideHeader ? 'hidden' : 'flex'} {split || toolbarFilters
          ? 'h-8 pb-[14px]'
          : 'h-[30px] pb-[14px]'} {wrapFilters
          ? '@max-[32rem]/listpage:h-auto! @max-[32rem]/listpage:flex-wrap'
          : ''} @max-[30rem]/pane:h-auto! @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:gap-y-2.5 @max-[30rem]/pane:pb-3"
      >
        {#if filters}{@render filters()}{:else}<span class="flex-1"></span>{/if}

        {#if primaryAction}
          <span
            class="mx-0.5 h-[18px] w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] @max-[30rem]/pane:hidden"
            aria-hidden="true"
          ></span>
          <!-- The only filled thing on the page, and it sits nearest the list
               it adds to rather than up in the crumb line. -->
          <button
            type="button"
            class="flex h-8 shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-primary px-[13px] text-workspace-chrome font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)] @max-[30rem]/pane:order-2 @max-[30rem]/pane:ml-auto @max-[30rem]/pane:h-10 @max-[30rem]/pane:rounded-full"
            onclick={primaryAction.run}
          >
            <PlusIcon size={16} weight="bold" class="shrink-0" />
            {primaryAction.label}
            {#if primaryAction.shortcut}
              <span class="text-xs opacity-80 @max-[30rem]/pane:hidden"
                >{primaryAction.shortcut}</span
              >
            {/if}
          </button>
        {/if}
      </div>
    {/if}

    <!-- ── Scroll: the only band that moves ── -->
    <div
      bind:this={scrollEl}
      bind:clientHeight={contentHeight}
      class="min-h-0 flex-1 {contentOwnsScroll
 ? 'overflow-hidden'
 : 'overflow-y-auto overscroll-y-contain pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:w-0'}"
    >
      {@render children()}
    </div>
  </div>
</div>
