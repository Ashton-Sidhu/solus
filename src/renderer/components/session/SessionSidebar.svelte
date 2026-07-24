<script lang="ts">
  import { tick } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { SvelteSet } from "svelte/reactivity";
  import { comboHint } from "../../lib/keybindings/manifest";
  import {
    PlusIcon,
    GitCommitIcon,
    GitForkIcon,
    FolderIcon,
    ArticleIcon,
    FileTextIcon,
    ClockIcon,
    CaretRightIcon,
    PushPinIcon,
    GearIcon,
    XIcon,
    LightningIcon,
    ListChecksIcon,
    GitPullRequestIcon,
    ColumnsIcon,
  } from "phosphor-svelte";
  import type { PinnedSession } from "../../../shared/types";
  import { getWorkspaceContext, getSessionSidebarStore } from "../../contexts";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    getAttentionIcon,
    attentionLabel,
    type AttentionState,
  } from "../../lib/sessionUtils";
  import SidePanel from "../layout/SidePanel.svelte";
  import * as Sidebar from "../ui/sidebar";
  import SessionContextMenu from "./SessionContextMenu.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";

  interface Props {
    open?: boolean;
    managedWidth?: boolean;
    onToggleCollapse?: () => void;
    onSessionSelect?: () => void;
  }
  let {
    open = true,
    managedWidth = false,
    onToggleCollapse,
    onSessionSelect,
  }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();
  const needsReviewCount = $derived(
    session.prsStore.needsReviewCountFor(session.ctx),
  );

  let scrollEl: HTMLDivElement | undefined = $state();
  let sessionContextMenu = $state<
    | { kind: "tab"; tabId: string; x: number; y: number }
    | { kind: "pinned"; pin: PinnedSession; x: number; y: number }
    | null
  >(null);
  const collapsedGroups = new SvelteSet<string>();
  const expandedBranches = new SvelteSet<string>();

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const expandDur = reduceMotion ? 0 : 180;

  // Shared utility-class clusters migrated from SessionSidebar.css. Kept as
  // consts only where reused across multiple rows; single-use clusters are
  // inlined on the element.
  const focusRing =
    "focus-visible:shadow-[inset_0_0_0_0.0938rem_var(--solus-accent)]";
  const dividerAfter =
    "after:content-[''] after:absolute after:bottom-0 after:left-3.5 after:right-3.5 after:h-px after:bg-[color-mix(in_srgb,var(--solus-container-border)_60%,transparent)]";
  // Active / hover accent washes shared by pinned, branch and child rows.
  const rowActiveWash =
    "bg-[color-mix(in_srgb,var(--solus-accent)_8%,transparent)] border-[color-mix(in_srgb,var(--solus-accent)_12%,transparent)]";
  const rowHoverWash =
    "hover:bg-(--solus-surface-hover) hover:border-[color-mix(in_srgb,var(--solus-container-border)_80%,transparent)]";
  const rowActiveHoverWash =
    "hover:bg-(--solus-surface-hover) hover:border-[color-mix(in_srgb,var(--solus-container-border)_80%,transparent)]";
  // Top-nav card cluster (Plans / Folio / Automations / …).
  const navCardBase =
    "group flex items-center gap-2 w-full h-8 px-2.5 rounded-lg bg-transparent cursor-pointer text-left text-(--solus-text-secondary) transition-[color,background] duration-150 hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover)";
  const navCardActive =
    "text-(--solus-text-primary) bg-[color-mix(in_srgb,var(--solus-accent)_8%,transparent)]";
  const navCardIcon =
    "flex items-center flex-shrink-0 text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-accent) group-data-active:text-(--solus-accent)";
  const navLabel =
    "text-[0.8125rem] font-normal tracking-[-0.01em] flex-1 text-left";
  const navHint =
    "text-[0.5938rem] text-(--solus-text-tertiary) font-mono flex-shrink-0 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70";
  const navBeta =
    "inline-flex items-center ml-1.5 px-1 py-px rounded text-[0.5313rem] font-normal tracking-[0.02em] uppercase leading-none align-middle text-(--solus-accent) bg-[color-mix(in_srgb,var(--solus-accent)_14%,transparent)]";
  const navCount =
    "inline-flex min-w-5 h-5 items-center justify-center rounded-full px-1.5 text-[0.625rem] font-semibold tabular-nums text-(--solus-accent) bg-[color-mix(in_srgb,var(--solus-accent)_14%,transparent)]";
  const sectionLabel =
    "text-[0.625rem] font-semibold uppercase tracking-[0.09em] text-(--solus-text-tertiary)";

  function toggleExpand(branchKey: string) {
    if (expandedBranches.has(branchKey)) expandedBranches.delete(branchKey);
    else expandedBranches.add(branchKey);
  }

  /** Kind-coded accent colour token used for markers. Peer colours, not a
      hierarchy: kind is an identity, not an importance ranking. */
  function branchKindColor(kind: "workspace" | "worktree" | "branch"): string {
    switch (kind) {
      case "worktree":
        return "var(--solus-art-3)";
      case "branch":
        return "var(--solus-art-5)";
      default:
        return "var(--solus-text-tertiary)";
    }
  }

  function toggleCollapse(key: string) {
    if (collapsedGroups.has(key)) collapsedGroups.delete(key);
    else collapsedGroups.add(key);
  }

  function togglePrs() {
    session.togglePrs();
    requestInputFocus();
  }

  function scrollActiveSessionIntoView() {
    if (!scrollEl) return;
    const activeEl = scrollEl.querySelector<HTMLElement>(
      '[data-active="true"]',
    );
    if (!activeEl) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const padding = 8;

    if (activeRect.top < scrollRect.top + padding) {
      scrollEl.scrollTop += activeRect.top - scrollRect.top - padding;
    } else if (activeRect.bottom > scrollRect.bottom - padding) {
      scrollEl.scrollTop += activeRect.bottom - scrollRect.bottom + padding;
    }
  }

  $effect(() => {
    const activeBranchKey = sidebarStore.activeBranchKey;
    void activeBranchKey;

    tick().then(() => {
      requestAnimationFrame(scrollActiveSessionIntoView);
    });
  });

  function selectBranch(branchKey: string, tabIds: string[]) {
    sidebarStore.selectBranch(branchKey, tabIds);
    requestInputFocus();
    onSessionSelect?.();
  }

  /** Create a new session inheriting the working dir / git context of a group. */
  async function newSessionForGroup(tabIds: string[]) {
    await sidebarStore.newSessionForGroup(tabIds);
    requestInputFocus();
    onSessionSelect?.();
  }

  /** Close every tab in a group (project or branch). */
  function closeTabs(tabIds: string[]) {
    sidebarStore.closeTabs(tabIds);
    requestInputFocus();
  }

  function openSessionContextMenu(
    event: MouseEvent,
    target: { kind: "tab"; tabId: string } | { kind: "pinned"; pin: PinnedSession },
  ) {
    event.preventDefault();
    event.stopPropagation();
    sessionContextMenu = { ...target, x: event.clientX, y: event.clientY };
  }

  function closeSessionContextMenu() {
    sessionContextMenu = null;
  }

  async function openPinnedSessionInSplit(pin: PinnedSession) {
    const openTabId = sidebarStore.openTabIdForPinned(pin);
    const splitTabId =
      openTabId ??
      (await session.resumeSession(
        {
          provider: pin.provider,
          sessionId: pin.sessionId,
          slug: null,
          firstMessage: pin.title,
          lastTimestamp: new Date(pin.pinnedAt).toISOString(),
          size: 0,
          cwd: pin.cwd,
          projectPath: "",
        },
        { background: true },
      ));
    session.openTabInSplit(splitTabId);
    onSessionSelect?.();
  }

  function openTabInSplit(tabId: string) {
    session.openTabInSplit(tabId);
    onSessionSelect?.();
  }
</script>

{#snippet pinnedSection()}
  {#if sidebarStore.pinnedSessions.length > 0}
    <Sidebar.Group class="flex-shrink-0 p-0 pb-1.5 relative {dividerAfter}">
      <Sidebar.GroupLabel class="h-auto px-4 pt-3 pb-1.5">
        <span class={sectionLabel}>Pinned</span>
      </Sidebar.GroupLabel>
      <Sidebar.GroupContent>
        <Sidebar.Menu class="gap-px px-2">
          {#each sidebarStore.pinnedSessions as pin (pin.sessionId)}
            {@const openTabId = sidebarStore.openTabIdForPinned(pin)}
            {@const isActive = !!openTabId && openTabId === session.activeTabId}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                class="gap-1.5 rounded-[0.4375rem] border border-transparent pl-8 pr-8 font-normal active:scale-[0.96] {focusRing} {isActive
                  ? rowActiveWash
                  : rowHoverWash}"
                {isActive}
                role="tab"
                aria-selected={isActive}
                aria-label={pin.title}
                title={pin.title}
                onclick={() => {
                  sidebarStore.openPinnedSession(pin);
                  onSessionSelect?.();
                }}
                oncontextmenu={(event) =>
                  openSessionContextMenu(event, { kind: "pinned", pin })}
              >
                <span
                  class="flex-1 min-w-0 font-normal leading-[1.2] tracking-[-0.01em] {isActive
                    ? 'text-(--solus-text-primary)'
                    : 'text-[color-mix(in_srgb,var(--solus-text-primary)_62%,var(--solus-text-secondary))]'}"
                  >{pin.title}</span
                >
              </Sidebar.MenuButton>
              <Sidebar.MenuAction
                class="pointer-events-none opacity-0 transition-[opacity,background-color,color] duration-150 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                aria-label="Open in split"
                tooltipContent="Open in split"
                onclick={(event) => {
                  event.stopPropagation();
                  void openPinnedSessionInSplit(pin);
                }}
              >
                <ColumnsIcon size={11} />
              </Sidebar.MenuAction>
              <Sidebar.MenuAction
                class="left-2 right-auto text-(--solus-accent) hover:text-(--solus-stop-bg) hover:bg-[color-mix(in_srgb,var(--solus-stop-bg)_12%,transparent)]"
                aria-label="Unpin session"
                tooltipContent="Unpin"
                onclick={(e) => {
                  e.stopPropagation();
                  void sidebarStore.unpinSession(pin);
                  requestInputFocus();
                }}
              >
                <PushPinIcon size={11} weight="fill" />
              </Sidebar.MenuAction>
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.GroupContent>
    </Sidebar.Group>
  {/if}
{/snippet}

<SidePanel
  title="Navigation"
  side="left"
  {open}
  {managedWidth}
  minWidth={160}
  maxWidth={400}
  onAction={onToggleCollapse}
  actionTooltip={`Collapse sidebar (${comboHint("global.toggle-sidebar")})`}
  actionAriaLabel="Collapse sidebar"
  background="color-mix(in srgb, var(--solus-container-bg) 90%, color-mix(in srgb, var(--solus-input-pill-bg) 70%, var(--solus-surface-primary)) 10%)"
>
  <Sidebar.Group class="flex-shrink-0 p-0 pb-1 relative {dividerAfter}">
    <Sidebar.GroupContent class="px-2 pb-2.5">
      <Sidebar.Menu class="gap-0">
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class={navCardBase}
            onclick={() => session.togglePlansGallery()}
          >
            <span class={navCardIcon}><ArticleIcon size={13} /></span>
            <span class={navLabel}>Plans</span>
            <span class={navHint}>⌥⇧L</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class={navCardBase}
            onclick={() => session.toggleFolioGallery()}
          >
            <span class={navCardIcon}><FileTextIcon size={13} /></span>
            <span class={navLabel}>Folio</span>
            <span class={navHint}>⌥⇧;</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="{navCardBase} {session.automationsOpen ? navCardActive : ''}"
            isActive={session.automationsOpen}
            onclick={() => session.toggleAutomations()}
          >
            <span class={navCardIcon}><LightningIcon size={13} /></span>
            <span class={navLabel}>Automations</span>
            <span class={navHint}>{comboHint("global.toggle-automations")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="{navCardBase} {session.prsOpen ? navCardActive : ''}"
            isActive={session.prsOpen}
            onclick={togglePrs}
          >
            <span class={navCardIcon}><GitPullRequestIcon size={13} /></span>
            <span class={navLabel}
              >Pull Requests<span class={navBeta}>Beta</span></span
            >
            {#if needsReviewCount > 0}
              <span
                class={navCount}
                title={`${needsReviewCount} pull ${needsReviewCount === 1 ? "request needs" : "requests need"} your review`}
                aria-label={`${needsReviewCount} need your review`}
              >{needsReviewCount > 99 ? "99+" : needsReviewCount}</span>
            {/if}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="{navCardBase} {session.tasksOpen ? navCardActive : ''}"
            isActive={session.tasksOpen}
            onclick={() => session.toggleTasks()}
          >
            <span class={navCardIcon}><ListChecksIcon size={13} /></span>
            <span class={navLabel}>Tasks<span class={navBeta}>Beta</span></span>
            <span class={navHint}>{comboHint("global.toggle-tasks")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class={navCardBase}
            onclick={() =>
              window.dispatchEvent(
                new CustomEvent("solus:toggle-session-picker"),
              )}
          >
            <span class={navCardIcon}><ClockIcon size={13} /></span>
            <span class={navLabel}>History</span>
            <span class={navHint}>{comboHint("global.session-picker")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.GroupContent>
  </Sidebar.Group>
  {@render pinnedSection()}
  <Sidebar.Group class="flex-shrink-0 p-0">
    <Sidebar.GroupLabel class="h-auto px-4 pt-3 pb-2">
      <span class={sectionLabel}>Projects</span>
    </Sidebar.GroupLabel>
    <Sidebar.GroupAction
      class="right-2 top-1.5 text-(--solus-text-tertiary)"
      aria-label="New session in project"
      onclick={() => {
        window.dispatchEvent(
          new CustomEvent("solus:open-directory-picker-new-tab"),
        );
      }}
      tooltipContent="New session in project…"
    >
      <PlusIcon size={14} />
    </Sidebar.GroupAction>
  </Sidebar.Group>

  <div
    bind:this={scrollEl}
    class="flex-1 overflow-y-auto px-2 pb-2 min-h-0"
    style="scrollbar-width:thin; -webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
  >
    {#snippet rowActions(
      tabIds: string[],
      label: string,
      showNew: boolean,
      showSplit = false,
    )}
      <span
        class="flex items-center gap-px flex-shrink-0 max-w-0 pl-0.5 overflow-hidden opacity-0 pointer-events-none transition-[max-width,opacity] duration-150 group-hover:max-w-12 group-hover:opacity-100 group-hover:pointer-events-auto focus-within:max-w-12 focus-within:opacity-100 focus-within:pointer-events-auto"
      >
        {#if showNew}
          <button
            class="flex items-center justify-center size-[1.125rem] rounded bg-transparent text-(--solus-text-tertiary) cursor-pointer p-0 outline-none transition-[color,background] duration-[120ms] hover:text-(--solus-accent) hover:bg-(--solus-surface-hover) focus-visible:shadow-[inset_0_0_0_0.0938rem_var(--solus-accent)]"
            aria-label="New session in {label}"
            use:tooltip={"New session"}
            onclick={(e) => {
              e.stopPropagation();
              void newSessionForGroup(tabIds);
            }}
          >
            <PlusIcon size={12} />
          </button>
        {/if}
        {#if showSplit && tabIds[0]}
          <button
            class="flex items-center justify-center size-[1.125rem] rounded bg-transparent text-(--solus-text-tertiary) cursor-pointer p-0 outline-none transition-[color,background] duration-[120ms] hover:text-(--solus-accent) hover:bg-(--solus-surface-hover) focus-visible:shadow-[inset_0_0_0_0.0938rem_var(--solus-accent)]"
            aria-label="Open {label} in split"
            use:tooltip={"Open in split"}
            onclick={(event) => {
              event.stopPropagation();
              openTabInSplit(tabIds[0]);
            }}
          >
            <ColumnsIcon size={12} />
          </button>
        {/if}
        <button
          class="flex items-center justify-center size-[1.125rem] rounded bg-transparent text-(--solus-text-tertiary) cursor-pointer p-0 outline-none transition-[color,background] duration-[120ms] hover:text-(--solus-stop-bg) hover:bg-[color-mix(in_srgb,var(--solus-stop-bg)_14%,transparent)] focus-visible:shadow-[inset_0_0_0_0.0938rem_var(--solus-stop-bg)]"
          aria-label={tabIds.length > 1
            ? `Close ${tabIds.length} sessions in ${label}`
            : `Close ${label}`}
          use:tooltip={tabIds.length > 1
            ? `Close ${tabIds.length} sessions`
            : "Close"}
          onclick={(e) => {
            e.stopPropagation();
            closeTabs(tabIds);
          }}
        >
          <XIcon size={12} />
        </button>
      </span>
    {/snippet}
    {#snippet attentionMark(att: AttentionState)}
      {#if att === "unread"}
        <span
          class="flex-shrink-0 size-1.5 rounded-full bg-(--solus-unread-ink) group-hover:hidden"
          aria-label="unread"
        ></span>
      {:else}
        {@const icon = getAttentionIcon(att)}
        {#if icon}
          {@const Icon = icon.component}
          <span
            class="flex items-center justify-center flex-shrink-0 leading-none group-hover:hidden {icon.spin
              ? 'animate-spin'
              : ''}"
            style="color:{icon.color}"
            aria-label={attentionLabel(att) || undefined}
          >
            <Icon size={10} weight="bold" />
          </span>
        {/if}
      {/if}
    {/snippet}
    <Sidebar.Menu class="gap-1">
      {#each sidebarStore.projectBranchGroups as pg (pg.projectKey)}
        {@const groupKey = `project:${pg.projectKey}`}
        {@const collapsed = collapsedGroups.has(groupKey)}
        {@const projectTabIds = pg.branches.flatMap((b) => b.tabIds)}
        {@const isProjectActive = projectTabIds.includes(session.activeTabId)}
        {@const showProjectActive = isProjectActive && collapsed}
        <Sidebar.MenuItem>
          <div
            class="group flex items-center gap-[0.3125rem] w-full h-8 px-2 cursor-pointer select-none rounded-[0.4375rem] outline-none transition-[background] duration-150 {focusRing} {showProjectActive
              ? 'bg-[color-mix(in_srgb,var(--solus-accent)_8%,transparent)]'
              : 'bg-transparent hover:bg-(--solus-surface-hover)'}"
            role="button"
            tabindex="0"
            data-active={showProjectActive ? "true" : undefined}
            onclick={() => toggleCollapse(groupKey)}
            aria-current={showProjectActive ? "page" : undefined}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleCollapse(groupKey);
              }
            }}
          >
            <ProjectFavicon projectRoot={pg.projectKey} />
            <span
              class="text-[0.6875rem] font-normal uppercase tracking-[0.05em] flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left {showProjectActive
                ? 'text-(--solus-text-primary)'
                : 'text-(--solus-text-tertiary)'}">{pg.projectLabel}</span
            >
            {#if collapsed && pg.attention}
              {@render attentionMark(pg.attention)}
            {/if}
            {@render rowActions(projectTabIds, pg.projectLabel, true)}
          </div>
          {#if !collapsed}
            <div
              class="flex flex-col gap-px pl-4 pb-1"
              transition:slide={{ duration: expandDur, easing: cubicOut }}
            >
              {#each pg.branches as branch (branch.key)}
                {@const isExpanded = expandedBranches.has(branch.key)}
                {@const isActiveBranch = branch.tabIds.includes(
                  session.activeTabId,
                )}
                {@const showBranchActive = isActiveBranch && !isExpanded}
                <div
                  class="group flex items-center gap-2 w-full h-8 px-2 rounded-[0.4375rem] border cursor-pointer outline-none text-(--solus-text-secondary) transition-[background,border-color,color] duration-150 {focusRing} {showBranchActive
                    ? `${rowActiveWash} ${rowActiveHoverWash} text-(--solus-text-primary)`
                    : `border-transparent bg-transparent ${rowHoverWash}`}"
                  style="--branch-kind-color:{branchKindColor(branch.kind)}"
                  role="button"
                  tabindex="0"
                  data-active={showBranchActive ? "true" : undefined}
                  onclick={() => selectBranch(branch.key, branch.tabIds)}
                  aria-current={showBranchActive ? "page" : undefined}
                  aria-expanded={isExpanded}
                  aria-label={branch.attention && branch.attention !== "running"
                    ? `${branch.label} — ${attentionLabel(branch.attention)}`
                    : branch.label}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectBranch(branch.key, branch.tabIds);
                    }
                  }}
                >
                  <!-- Kind shown by a meaningful glyph; name typography is
                     identical for every kind. branch=ordinary branch (incl.
                     main), worktree=parallel checkout, workspace=non-git folder.
                     pending=worktree requested, awaiting creation on first turn. -->
                  {#if branch.pending}
                    <GitForkIcon
                      size={12}
                      class="flex-shrink-0 w-3.5 text-(--solus-accent) motion-safe:animate-pulse"
                    />
                  {:else if branch.kind === "workspace"}
                    <FolderIcon
                      size={12}
                      class="flex-shrink-0 w-3.5 text-(--branch-kind-color)"
                    />
                  {:else if branch.kind === "worktree"}
                    <GitForkIcon
                      size={12}
                      class="flex-shrink-0 w-3.5 text-(--branch-kind-color)"
                    />
                  {:else}
                    <GitCommitIcon
                      size={12}
                      class="flex-shrink-0 w-3.5 text-(--branch-kind-color)"
                    />
                  {/if}
                  <span
                    class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-normal text-left"
                  >
                    {branch.label}
                  </span>
                  {@render rowActions(branch.tabIds, branch.label, true)}
                  {#if branch.attention && !isExpanded}
                    {@render attentionMark(branch.attention)}
                  {/if}
                  <button
                    class="flex-shrink-0 flex items-center justify-center size-[1.125rem] rounded bg-transparent text-(--solus-text-tertiary) cursor-pointer p-0 outline-none transition-[color,background,transform] duration-150 hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover) {focusRing} {isExpanded
                      ? 'rotate-90'
                      : ''}"
                    aria-label={isExpanded
                      ? "Collapse sessions"
                      : "Expand sessions"}
                    onclick={(e) => {
                      e.stopPropagation();
                      toggleExpand(branch.key);
                    }}
                    onkeydown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleExpand(branch.key);
                      }
                    }}
                  >
                    <CaretRightIcon size={9} />
                  </button>
                </div>
                {#if isExpanded}
                  <div
                    class="flex flex-col gap-px"
                    transition:slide={{ duration: expandDur, easing: cubicOut }}
                  >
                    {#each branch.tabIds as tabId (tabId)}
                      {@const child = sidebarStore.childForTab(tabId)}
                      {@const showChildActive = isActiveBranch && child.active}
                      <div
                        class="group flex items-center gap-1.5 w-full h-8 pl-7 pr-2 rounded-[0.4375rem] border cursor-pointer text-[0.8125rem] outline-none text-(--solus-text-secondary) transition-[background,border-color,color] duration-150 {focusRing} {showChildActive
                          ? `${rowActiveWash} text-(--solus-text-primary)`
                          : `border-transparent bg-transparent ${rowHoverWash}`}"
                        role="button"
                        tabindex="0"
                        data-active={showChildActive ? "true" : undefined}
                        onclick={() => {
                          sidebarStore.selectTab(tabId);
                          requestInputFocus();
                          onSessionSelect?.();
                        }}
                        onkeydown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            sidebarStore.selectTab(tabId);
                            requestInputFocus();
                            onSessionSelect?.();
                          }
                        }}
                        oncontextmenu={(event) =>
                          openSessionContextMenu(event, { kind: "tab", tabId })}
                        aria-current={showChildActive ? "page" : undefined}
                        aria-label={child.label}
                      >
                        <span
                          class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left"
                        >
                          {child.label}
                        </span>
                        {#if child.attention}
                          {@render attentionMark(child.attention)}
                        {/if}
                        {@render rowActions([tabId], child.label, false, true)}
                      </div>
                    {/each}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </Sidebar.MenuItem>
      {/each}
    </Sidebar.Menu>
  </div>

  <Sidebar.Footer
    class="flex-shrink-0 relative px-2 pt-1.5 pb-2 before:content-[''] before:absolute before:top-0 before:left-3.5 before:right-3.5 before:h-px before:bg-[color-mix(in_srgb,var(--solus-container-border)_60%,transparent)]"
  >
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton
          class="group flex items-center gap-2 w-full h-[1.875rem] px-2.5 rounded-lg bg-transparent cursor-pointer text-(--solus-text-tertiary) outline-none select-none transition-[background,transform] duration-150 hover:bg-(--solus-surface-hover) {focusRing} {session.settingsOpen
            ? 'bg-[color-mix(in_srgb,var(--solus-accent)_8%,transparent)]'
            : ''}"
          isActive={session.settingsOpen}
          onclick={() => session.showSettings()}
        >
          <span
            class="flex items-center flex-shrink-0 motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:rotate-90 {session.settingsOpen
              ? 'text-(--solus-accent)'
              : 'text-(--solus-text-tertiary) group-hover:text-(--solus-accent)'}"
            ><GearIcon size={14} /></span
          >
          <span
            class="text-[0.8125rem] font-normal tracking-[-0.01em] flex-1 text-left {session.settingsOpen
              ? 'text-(--solus-text-primary)'
              : 'text-(--solus-text-secondary) group-hover:text-(--solus-text-primary)'}"
            >Settings</span
          >
          <span
            class="text-[0.5938rem] text-(--solus-text-tertiary) font-mono flex-shrink-0 opacity-0 group-hover:opacity-70"
            >{comboHint("global.settings")}</span
          >
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Footer>
</SidePanel>

{#if sessionContextMenu}
  {#if sessionContextMenu.kind === "tab"}
    <SessionContextMenu
      x={sessionContextMenu.x}
      y={sessionContextMenu.y}
      tabId={sessionContextMenu.tabId}
      showSplit
      onClose={closeSessionContextMenu}
    />
  {:else}
    {@const pin = sessionContextMenu.pin}
    <SessionContextMenu
      x={sessionContextMenu.x}
      y={sessionContextMenu.y}
      tabId={sidebarStore.openTabIdForPinned(pin) ?? null}
      sessionId={pin.sessionId}
      showSplit
      onOpenInSplit={() => void openPinnedSessionInSplit(pin)}
      onClose={closeSessionContextMenu}
    />
  {/if}
{/if}
