<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ArrowClockwiseIcon,
    ListIcon,
    PlusIcon,
    TrayIcon,
    XIcon,
  } from "phosphor-svelte";
  import { PAGE_ICON_BTN } from "../../../lib/page-chrome";
  import {
    statTintColor,
    type ListPageView,
    type ListProjectOption,
    type ListSummaryStat,
  } from "./list-page";
  import ListProjectSwitcher from "./ListProjectSwitcher.svelte";

  /**
   * The shell both list pages are built in ("List pages" spec, Part A). Two
   * bands in a full-height flex column: a fixed head (title block + filters)
   * and one scroll region — so the search field is always on screen no matter
   * how long the list is.
   *
   * Keys are not legended along the bottom; each one is stated on the control
   * it drives, so the shortcut is learned where it is used.
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
     *  The switcher stands above the title — the scope is stated and changed in
     *  the same place. */
    projects?: ListProjectOption[];
    activeProjectKey?: string;
    /** Shown when no project is scoped yet. */
    emptyProjectLabel?: string;
    onSelectProject?: (projectKey: string) => void;
    title: string;
    /** The first stat is the lead and the only coloured text in the header. */
    summary: ListSummaryStat[];
    /** Omit the switch entirely by leaving `onViewChange` unset. */
    view?: ListPageView;
    onViewChange?: (view: ListPageView) => void;
    globalLabel?: string;
    inboxLabel?: string;
    /** Drives the inbox badge; brand-coloured only while the inbox is active. */
    unreadCount?: number;
    onRefresh?: () => void;
    refreshing?: boolean;
    /** The page's one creating action. */
    primaryAction?: { label: string; shortcut?: string; run: () => void };
    onClose?: () => void;
    /** Extra controls between the view switch and refresh (project switchers, bulk actions). */
    actions?: Snippet;
    /** The filter bar. Fixed, below the title block. */
    filters?: Snippet;
    /** The scroll region. */
    children: Snippet;
    scrollEl?: HTMLDivElement | null;
    /** The child (for example a virtual list) owns vertical scrolling. */
    contentOwnsScroll?: boolean;
    contentHeight?: number;
    /** The list is docked beside an open detail panel: it drops the reading
     *  measure, tightens the gutters and the head, and gives up the summary
     *  line, because the column is now a place to navigate from rather than the
     *  page you are reading. */
    split?: boolean;
  }
  let {
    projects,
    activeProjectKey,
    emptyProjectLabel,
    onSelectProject,
    title,
    summary,
    view = "global",
    onViewChange,
    globalLabel = "All",
    inboxLabel = "My inbox",
    unreadCount = 0,
    onRefresh,
    refreshing = false,
    primaryAction,
    onClose,
    actions,
    filters,
    children,
    scrollEl = $bindable(null),
    contentOwnsScroll = false,
    contentHeight = $bindable(0),
    split = false,
  }: Props = $props();

  const headTop = $derived(split ? "26px" : "42px");

  const isInbox = $derived(view === "inbox");
  // A segment is either the raised card chip or plain muted text; there is no
  // third state, so both segments read from one recipe.
  const segment = (active: boolean) =>
    active
      ? "bg-card font-medium text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]"
      : "bg-transparent text-muted-foreground";
</script>

<div
  class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-[0.8125rem] text-foreground"
>
  <div
    class="mx-auto flex min-h-0 w-full flex-1 flex-col {split
 ? 'px-[18px]'
 : 'max-w-[72rem] px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4'}"
  >
    <!-- ── Head: title block + action cluster ── -->
    <div
      class="flex shrink-0 items-end justify-between gap-8 {split
 ? 'flex-wrap gap-y-3 pb-[18px]'
 : 'pb-[22px]'}"
      style="padding-top: {headTop}"
    >
      {#if !split}
        <div class="flex min-w-0 flex-col gap-[9px]">
          <h1 class="text-[1.5rem] font-medium whitespace-nowrap">
            {title}
          </h1>

          <div
            class="flex items-center gap-2 text-xs text-muted-foreground"
          >
            {#each summary as stat, i (stat.label)}
              {#if i > 0}<span class="opacity-35" aria-hidden="true">·</span
                >{/if}
              <span
                class="tabular-nums {i === 0 ? 'font-medium' : ''}"
                style={i === 0 && statTintColor(stat.tint)
                  ? `color: ${statTintColor(stat.tint)}`
                  : undefined}
              >
                {stat.label}
              </span>
            {/each}
          </div>
        </div>
      {/if}

      <div class="flex shrink-0 items-center gap-2">
        {#if !split && projects}
          <ListProjectSwitcher
            {projects}
            {activeProjectKey}
            emptyLabel={emptyProjectLabel}
            onSelect={onSelectProject}
          />
        {/if}

        {#if onViewChange}
          <div
            class="flex items-center gap-0.5 rounded-full bg-[var(--wash-2)] p-0.5 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
            role="group"
            aria-label="View"
          >
            <button
              type="button"
              class="flex h-[26px] cursor-pointer items-center gap-[7px] rounded-full border-0 px-[13px] text-[0.8125rem] transition-colors duration-150 {segment(
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
              class="flex h-[26px] cursor-pointer items-center gap-[7px] rounded-full border-0 px-[13px] text-[0.8125rem] transition-colors duration-150 {segment(
 isInbox,
 )}"
              onclick={() => onViewChange?.("inbox")}
              aria-pressed={isInbox}
            >
              <TrayIcon size={12} class="shrink-0" />
              {inboxLabel}
              <span
                class="rounded-full px-[5px] py-px font-mono text-xs tabular-nums {isInbox
 ? 'bg-[color-mix(in_oklch,var(--primary)_15%,transparent)] text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
 : 'bg-[var(--wash-3)] text-muted-foreground'}"
              >
                {unreadCount}
              </span>
            </button>
          </div>
        {/if}

        {#if actions}{@render actions()}{/if}

        {#if onRefresh}
          <button
            type="button"
            class="flex size-[26px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            onclick={onRefresh}
            disabled={refreshing}
            aria-label={refreshing ? "Refreshing" : "Refresh"}
            title={refreshing ? "Refreshing…" : "Refresh"}
          >
            <ArrowClockwiseIcon
              size={13}
              class={refreshing ? "animate-spin [animation-duration:0.9s]" : ""}
            />
          </button>
        {/if}

        {#if primaryAction}
          <button
            type="button"
            class="flex h-[30px] cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-primary px-[13px] text-[0.8125rem] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)]"
            onclick={primaryAction.run}
          >
            <PlusIcon size={12} weight="bold" class="shrink-0" />
            {primaryAction.label}
            {#if primaryAction.shortcut}
              <span class="font-mono text-xs opacity-80"
                >{primaryAction.shortcut}</span
              >
            {/if}
          </button>
        {/if}

        {#if onClose}
          <button
            type="button"
            class={PAGE_ICON_BTN}
            onclick={onClose}
            aria-label="Close"
          >
            <XIcon size={14} />
          </button>
        {/if}
      </div>
    </div>

    {#if filters}{@render filters()}{/if}

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
