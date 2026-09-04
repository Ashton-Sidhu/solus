<script lang="ts">
  import type { Snippet } from "svelte";
  import { List as ListIcon, Plus as PlusIcon, Archive as TrayIcon } from "@lucide/svelte";
  import type { NavPage } from "../../../lib/page-nav";
  import type { ListPageView, ListProjectOption } from "./list-page";
  import PageCrumbLine from "./PageCrumbLine.svelte";

  /**
   * The shell every page-level list is built in ("List pages" spec, Part A).
   * Two fixed rows over one scroll region, each row with a single job:
   *
   *   Row 1 — the breadcrumb. Answers *where am I*, holds nothing that filters.
   *   Row 2 — search, filters, sort, view, and the page's one creating action.
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
    /** The project the list is reading, and the projects it can be pointed at.
     *  The switcher is the title's leading crumb — the scope is stated and
     *  changed in the same place. */
    projects?: ListProjectOption[];
    /** The scoped project's host-qualified `key`. */
    activeProjectKey?: string;
    /** Shown when no project is scoped yet. */
    emptyProjectLabel?: string;
    onSelectProject?: (option: ListProjectOption) => void;
    /** Forgets a catalog-only project from a page's switcher. */
    onRemoveProjectHistory?: (option: ListProjectOption) => void;
    /** Leads the switcher with an "All projects" row that clears the scope. */
    onSelectAllProjects?: () => void;
    allProjectsLabel?: string;
    /** What the page does to its other controls when the scope changes. */
    projectSwitchNote?: string;
    /** Which page the second crumb stands on. */
    page: NavPage;
    /** Overrides the page's own name in the crumb — a page under two scopes
     *  passes the scope's own name, so the crumb states which one is on screen
     *  while the switch below it does the switching. */
    title?: string;
    /** Which scope the page is reading. Omit the switch entirely by leaving
     *  `onViewChange` unset. */
    view?: ListPageView;
    onViewChange?: (view: ListPageView) => void;
    globalLabel?: string;
    inboxLabel?: string;
    compactViewSwitcherText?: boolean;
    /** Drives the inbox badge; brand-coloured only while the inbox is active. */
    unreadCount?: number;
    onRefresh?: () => void;
    refreshing?: boolean;
    /** When the page last finished loading — the refresh chip's own label. */
    syncedAt?: number | null;
    /** The rows on screen came off a cached copy, not from the provider. */
    syncFromCache?: boolean;
    /** The page's one creating action. */
    primaryAction?: { label: string; shortcut?: string; run: () => void };
    compactPrimaryActionText?: boolean;
    /** Move the page between the leading pane and the companion beside it.
     *  Absent where there is no pane to move to — pill mode renders these pages
     *  inline. */
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
     *  controls. The narrowing row keeps the split head's top inset. */
    hideHeader?: boolean;
    /** A docked record can keep a stable page title without turning it into a
     *  second page-navigation control. */
    pageSwitcherEnabled?: boolean;
  }
  let {
    projects,
    activeProjectKey,
    emptyProjectLabel,
    onSelectProject,
    onRemoveProjectHistory,
    onSelectAllProjects,
    allProjectsLabel,
    projectSwitchNote,
    page,
    title,
    view = "global",
    onViewChange,
    globalLabel = "All",
    inboxLabel = "My inbox",
    compactViewSwitcherText = false,
    unreadCount = 0,
    onRefresh,
    refreshing = false,
    syncedAt = null,
    syncFromCache = false,
    primaryAction,
    compactPrimaryActionText = false,
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
    pageSwitcherEnabled = true,
  }: Props = $props();

  // The head's own measure. A laptop display gives up the generous desktop top
  // band so the first row lands higher on a short screen; the type on the head
  // still comes from the shared chrome rung, never from this boundary.
  const headPad = $derived(
    split
      ? "pt-[26px] [.is-laptop-display_&]:pt-5"
      : "pt-[42px] [.is-laptop-display_&]:pt-8",
  );

  const isInbox = $derived(view === "inbox");
  // A segment is either the raised card chip or plain muted text; there is no
  // third state, so both segments read from one recipe.
  const segment = (active: boolean) =>
    active
      ? "bg-card font-medium text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]"
      : "bg-transparent text-muted-foreground";
</script>

<div
  class="text-chrome-dense relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
>
  <div
    class="mx-auto flex min-h-0 w-full flex-1 flex-col {split
      ? 'px-[18px]'
      : 'max-w-[72rem] px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4'} {hideHeader
      ? headPad
      : ''}"
  >
    <!-- ── Row 1: the breadcrumb, and the controls that act on the window ── -->
    {#if !hideHeader}
      <!-- The row is exactly its tallest control, stated rather than inferred:
           the loading silhouette reserves the same box, so the list under it
           does not drop when the real page arrives.

           At the record rung the tallest control is the 44px drawer button, and
           both the rung's height and its bottom measure are marked `!` for the
           same reason: a laptop-display variant is two selectors to the rung's
           one, so on a phone-width pane it won the height and left the button
           overflowing a 27px box — swallowing the whole gap under it and
           putting the filter band 1px below the button. -->
      <div
        class="workspace-titlebar box-content flex h-[31px] shrink-0 items-center pointer-coarse:h-9 pointer-fine:[.is-laptop-display_&]:h-[27px] @max-[30rem]/pane:h-11! @max-[30rem]/pane:pb-2.5! {headPad} {split
 ? 'pb-[11px] [.is-laptop-display_&]:pb-2'
 : 'pb-[13px] [.is-laptop-display_&]:pb-2.5'}"
      >
        <!-- The narrow rail is navigation for the open detail: changing project
             there would replace the queue the reader is navigating from, so it
             gives up the project segment and keeps the rest of the line. -->
        <PageCrumbLine
          projects={split ? undefined : projects}
          {activeProjectKey}
          {emptyProjectLabel}
          {onSelectProject}
          {onRemoveProjectHistory}
          {onSelectAllProjects}
          {allProjectsLabel}
          {projectSwitchNote}
          {page}
          pageLabel={title}
          {pageSwitcherEnabled}
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
    {#if filters || onViewChange || primaryAction}
      <!-- At the record rung this wraps into two lines rather than running off
           the pane: the view switch and the one creating action keep the first,
           and the filter bar takes a full-width second, where it splits itself
           into a search field and a scrolling chip row. -->
      <div
        class="box-content flex shrink-0 items-center gap-2 {split || toolbarFilters
          ? 'h-8 pb-[14px]'
          : 'h-[30px] pb-[14px] [.is-laptop-display_&]:h-[26px] [.is-laptop-display_&]:pb-3'} @max-[30rem]/pane:h-auto! @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:gap-y-2.5 @max-[30rem]/pane:pb-3"
      >
        {#if onViewChange}
          <!-- The broadest narrowing there is, so it leads the row: everything
               after it narrows further inside whichever half is chosen. The
               crumb above states which half is on screen; this is what moves
               between them. -->
          <div
            class="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--wash-2)] p-0.5 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)] {compactViewSwitcherText
              ? 'text-xs'
              : ''}"
            role="group"
            aria-label="View"
          >
            <button
              type="button"
              class="flex h-[26px] cursor-pointer items-center gap-[7px] rounded-full border-0 px-[13px] transition-colors duration-150 {segment(
 !isInbox,
 )}"
              onclick={() => onViewChange?.("global")}
              aria-pressed={!isInbox}
            >
              <ListIcon size={12} class="shrink-0" />
              {globalLabel}
            </button>
            <button
              type="button"
              class="flex h-[26px] cursor-pointer items-center gap-[7px] rounded-full border-0 px-[13px] transition-colors duration-150 {segment(
 isInbox,
 )}"
              onclick={() => onViewChange?.("inbox")}
              aria-pressed={isInbox}
            >
              <TrayIcon size={12} class="shrink-0" />
              {inboxLabel}
              <span
                class="rounded-full px-[5px] py-px text-xs tabular-nums {isInbox
 ? 'bg-[color-mix(in_oklch,var(--primary)_15%,transparent)] text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
 : 'bg-[var(--wash-3)] text-muted-foreground'}"
              >
                {unreadCount}
              </span>
            </button>
          </div>
        {/if}

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
            class="flex h-[30px] shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-primary px-[13px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)] [.is-laptop-display_&]:h-[26px] [.is-laptop-display_&]:px-2.5 @max-[30rem]/pane:order-2 @max-[30rem]/pane:ml-auto @max-[30rem]/pane:h-9! @max-[30rem]/pane:rounded-full {compactPrimaryActionText
              ? 'text-xs'
              : ''}"
            onclick={primaryAction.run}
          >
            <PlusIcon size={12} weight="bold" class="shrink-0" />
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
