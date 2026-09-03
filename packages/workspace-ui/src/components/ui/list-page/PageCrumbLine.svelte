<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    PanelLeft as SidebarSimpleIcon,
    RotateCw as ArrowClockwiseIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { PAGE_ICON_BTN } from "../../../lib/page-chrome";
  import type { NavPage } from "../../../lib/page-nav";
  import { frameChrome } from "../../layout/frame-chrome.store.svelte";
  import PaneSwapButton from "../PaneSwapButton.svelte";
  import { syncLabel, type ListProjectOption } from "./list-page";
  import ListProjectSwitcher from "./ListProjectSwitcher.svelte";
  import PageCrumbMenu from "./PageCrumbMenu.svelte";

  /**
   * Row one of every page head: `<project> / <page>`, then the controls that act
   * on the window rather than on the list.
   *
   * Both crumb segments are menus. The line answers *where am I* and holds
   * nothing that filters — narrowing lives on the row under it, so a control
   * that does neither belongs in neither row.
   *
   * The utility controls land by meaning rather than in a strip: refresh is
   * fused with the timestamp it describes, and the window pair (open in split,
   * close) follows past a divider so it stops competing with the page's own
   * primary action.
   */
  interface Props {
    /** The projects the page can be pointed at. Omitted by a page with no
     *  project scope (Insights reads a host-local database), which then has no
     *  leading crumb at all. */
    projects?: ListProjectOption[];
    activeProjectKey?: string;
    emptyProjectLabel?: string;
    onSelectProject?: (option: ListProjectOption) => void;
    onRemoveProjectHistory?: (option: ListProjectOption) => void;
    onSelectAllProjects?: () => void;
    allProjectsLabel?: string;
    projectSwitchNote?: string;
    /** Which page the second crumb stands on, and which row its menu marks. */
    page: NavPage;
    /** Overrides the page's own name in the crumb. A page under two scopes
     *  passes the scope's own name ("Inbox"), so the crumb states which one is
     *  on screen; the switch that moves between them is on the row below. */
    pageLabel?: string;
    /** A third, plain segment after the page — a position inside the page that
     *  is not itself a destination (Insights' current question). */
    trailingCrumb?: string;
    /** Page-specific chips at the far end of the line: provider identity, a
     *  bulk-selection count. Rendered before the sync chip. */
    actions?: Snippet;
    onRefresh?: () => void;
    refreshing?: boolean;
    /** When the page last finished loading. Without it the chip is the bare
     *  verb rather than a timestamp it cannot vouch for. */
    syncedAt?: number | null;
    /** The rows on screen came off a cached copy, not from the provider. */
    syncFromCache?: boolean;
    onMoveAcross?: () => void;
    isLeading?: boolean;
    onClose?: () => void;
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
    pageLabel,
    trailingCrumb,
    actions,
    onRefresh,
    refreshing = false,
    syncedAt = null,
    syncFromCache = false,
    onMoveAcross,
    isLeading = true,
    onClose,
  }: Props = $props();

  // The chip's label ages while the page sits open, so it needs a clock of its
  // own. One interval per head, and only while there is a timestamp to age.
  let now = $state(Date.now());
  $effect(() => {
    if (!syncedAt) return;
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  const syncText = $derived(
    syncLabel(syncedAt, now, refreshing, syncFromCache),
  );

  const hasWindowActions = $derived(!!onMoveAcross || !!onClose);
</script>

<!-- Full width by declaration: the row's own spacer is what pushes the window
     controls to the far end, and a content-width box would collapse it. -->
<div class="flex w-full min-w-0 items-center gap-2 text-workspace-chrome">
  <!-- The way back to everything else, on the shell that has no persistent
       sidebar to hold it. It leads the line at the record rung and is absent
       everywhere else, because a frame with a session sidebar already shows
       what this would open. -->
  {#if frameChrome.openNavigationDrawer}
    <button
      type="button"
      class="relative -ml-1.5 hidden size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-foreground active:bg-[var(--wash-2)] @max-[30rem]/pane:flex [-webkit-tap-highlight-color:transparent]"
      onclick={frameChrome.openNavigationDrawer}
      aria-label="Open navigation"
    >
      <SidebarSimpleIcon size={19} />
      {#if frameChrome.navigationHasUnseen}
        <span
          class="absolute top-1.5 right-1.5 size-[7px] rounded-full bg-primary shadow-[0_0_0_2px_var(--background)]"
          aria-hidden="true"
        ></span>
      {/if}
    </button>
  {/if}

  <!-- ── The record rung (`@max-[30rem]/pane`) ──
       A phone has no room for `<project> / <page>` in front of the page's own
       controls: the project ate the line, the page name truncated to a stub,
       and the ✕ at the far end was squeezed to 35px — below the touch floor,
       on the one shell where every target is a thumb. So the crumb unfolds. The
       page name takes the whole line at the title rung, the project becomes a
       chip at the far end, and the ✕ stands down because a phone renders one
       pane and the drawer is already the way out. `order` places each part, so
       this is the same line reflowing rather than a second header. -->
  <nav
    class="flex min-w-0 shrink items-center gap-0.5 @max-[30rem]/pane:flex-1 @max-[30rem]/pane:gap-2"
    aria-label="Location"
  >
    {#if projects}
      <span class="contents @max-[30rem]/pane:order-8 @max-[30rem]/pane:block">
        <ListProjectSwitcher
          variant="crumb"
          {projects}
          activeKey={activeProjectKey}
          emptyLabel={emptyProjectLabel}
          onSelect={onSelectProject}
          onRemoveHistory={onRemoveProjectHistory}
          onSelectAll={onSelectAllProjects}
          allLabel={allProjectsLabel}
          footerNote={projectSwitchNote}
        />
      </span>
      <span
        class="shrink-0 px-px text-[15px] text-muted-foreground opacity-30 @max-[30rem]/pane:hidden"
        aria-hidden="true">/</span
      >
    {/if}
    <PageCrumbMenu {page} label={pageLabel} />
    {#if trailingCrumb}
      <span
        class="shrink-0 px-px text-[15px] text-muted-foreground opacity-30"
        aria-hidden="true">/</span
      >
      <span
        class="min-w-0 truncate px-2.5 text-muted-foreground [.is-laptop-display_&]:px-2"
        title={trailingCrumb}>{trailingCrumb}</span
      >
    {/if}
  </nav>

  <!-- On a record the location line is itself elastic, so this would be a
       second claim on the same slack and the project chip would drift off the
       right edge. -->
  <span class="min-w-2 flex-1 @max-[30rem]/pane:hidden" aria-hidden="true"></span>

  {#if actions}{@render actions()}{/if}

  {#if onRefresh}
    <!-- One control: the timestamp is the label and the whole chip is the
         button, so the fact and the way to renew it can never disagree. -->
    <button
      type="button"
      class="flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent pr-[9px] pl-[7px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      onclick={onRefresh}
      disabled={refreshing}
      aria-label={refreshing ? "Refreshing" : "Refresh"}
      title={refreshing ? "Refreshing…" : "Refresh"}
    >
      <ArrowClockwiseIcon
        size={12}
        class="shrink-0 {refreshing
          ? 'animate-spin [animation-duration:0.9s] motion-reduce:animate-none'
          : ''}"
      />
      <span class="text-chrome-shelf whitespace-nowrap @max-[34rem]:hidden"
        >{syncText}</span
      >
    </button>
  {/if}

  {#if hasWindowActions}
    <span
      class="mx-1 h-4 w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] @max-[30rem]/pane:hidden"
      aria-hidden="true"
    ></span>
  {/if}

  <!-- Moving a page between the leading pane and its companion needs a
       companion. The phone shell renders exactly one pane, so at the record
       rung this control has nowhere to send the page — and the ~40px it costs
       is what the project crumb needs to say a name instead of one letter. -->
  {#if onMoveAcross}
    <span class="contents @max-[30rem]/pane:hidden">
      <PaneSwapButton {isLeading} onMove={onMoveAcross} iconSize={14} />
    </span>
  {/if}

  <!-- Closing a page needs somewhere to land. The phone shell renders one pane
       and reaches every destination through the drawer at the head of this
       line, so at the record rung the ✕ is a second way out that costs the page
       title its width — and it was the control that got squeezed below the
       touch floor when the project name grew. The drawer is the way out. -->
  {#if onClose}
    <span class="contents @max-[30rem]/pane:hidden">
      <button
        type="button"
        class={PAGE_ICON_BTN}
        onclick={onClose}
        aria-label="Close"
      >
        <XIcon size={14} />
      </button>
    </span>
  {/if}
</div>
