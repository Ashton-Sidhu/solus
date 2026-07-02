<script lang="ts">
  import "./TabStrip.css";

  import { flip } from "svelte/animate";
  import { tick } from "svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { scale } from "svelte/transition";
  import { quintOut } from "svelte/easing";
  import {
    PlusIcon,
    XIcon,
    ArticleIcon,
    FileTextIcon,
    ClockIcon,
    CaretLeftIcon,
    CaretRightIcon,
    GitForkIcon,
    TreeStructureIcon,
    FunnelSimpleIcon,
    SidebarSimpleIcon,
    HandPalmIcon,
    ArrowsClockwiseIcon,
    CheckCircleIcon,
    XCircleIcon,
    CircleDashedIcon,
    CircleIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getPlanStore } from "../../contexts/plan.store.svelte";
  import type { TabGroupMode } from "../../contexts/settings.context.svelte";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { createTabScroll } from "../../lib/tabScroll.svelte";
  import { portal } from "../portal";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import {
    getAttentionState,
    attentionLabel,
    getStatusIcon,
    buildTabSections,
    STATUS_GROUP_LABELS,
    UNREAD_GROUP_LABELS,
    projectByline,
    type StatusGroupKey,
    type UnreadGroupKey,
  } from "../../lib/sessionUtils";
  import type { Tab, Session } from "../../../shared/types";

  interface Props {
    tabIds?: string[];
    variant?: "pill" | "editor";
    sidebarOpen?: boolean;
    onToggleSidebar?: () => void;
    projectPanelOpen?: boolean;
    onToggleProjectPanel?: () => void;
  }

  let {
    tabIds,
    variant = "pill",
    sidebarOpen = true,
    onToggleSidebar,
    projectPanelOpen = true,
    onToggleProjectPanel,
  }: Props = $props();

  // The bar only hosts a panel toggle while that panel is COLLAPSED — it's the
  // expand affordance. When the panel is open it owns its own collapse control in
  // its header, so the bar stays clean.
  const showSidebarToggle = $derived(
    variant === "editor" && !sidebarOpen && !!onToggleSidebar,
  );
  const showPanelToggle = $derived(
    variant === "editor" && !projectPanelOpen && !!onToggleProjectPanel,
  );

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const renderedTabIds = $derived(tabIds ?? session.tabOrder);

  // Per-group binder-divider lead: a representative status icon, accent color,
  // and whether it spins. Grouped mode shows this glyph on the divider and hides
  // it on the individual tabs, so the status reads once per section.
  type GroupVisual = {
    icon: any;
    color: string;
    spin: boolean;
    weight?: "fill";
  };

  const GROUP_VISUAL: Record<StatusGroupKey, GroupVisual> = {
    waiting: {
      icon: HandPalmIcon,
      color: "var(--solus-status-permission)",
      spin: false,
    },
    "rate-limited": {
      icon: ClockIcon,
      color: "var(--solus-status-permission)",
      spin: false,
    },
    running: {
      icon: ArrowsClockwiseIcon,
      color: "var(--solus-status-running)",
      spin: true,
    },
    completed: {
      icon: CheckCircleIcon,
      color: "var(--solus-status-complete)",
      spin: false,
    },
    error: {
      icon: XCircleIcon,
      color: "var(--solus-status-error)",
      spin: false,
    },
    idle: {
      icon: CircleDashedIcon,
      color: "var(--solus-text-tertiary)",
      spin: false,
    },
  };

  const UNREAD_VISUAL: Record<UnreadGroupKey, GroupVisual> = {
    unread: {
      icon: CircleIcon,
      color: "var(--solus-unread-ink)",
      spin: false,
      weight: "fill",
    },
    read: {
      icon: CircleDashedIcon,
      color: "var(--solus-text-tertiary)",
      spin: false,
    },
  };

  // Section label + binder glyph per grouping mode, looked up by section key.
  const GROUP_PRESENTATION: Record<
    "status" | "unread",
    {
      labels: Record<string, string>;
      visual: Record<string, GroupVisual>;
    }
  > = {
    status: { labels: STATUS_GROUP_LABELS, visual: GROUP_VISUAL },
    unread: { labels: UNREAD_GROUP_LABELS, visual: UNREAD_VISUAL },
  };

  // Tooltip names the CURRENT grouping plus the mode the toggle switches INTO
  // (it cycles flat → status → unread).
  const GROUP_TOOLTIPS: Record<TabGroupMode, string> = {
    flat: "Tabs: ungrouped · group by status (⌥⇧U)",
    status: "Tabs: grouped by status · group by unread (⌥⇧U)",
    unread: "Tabs: grouped by unread · ungroup (⌥⇧U)",
  };

  const isGrouped = $derived(session.tabGroupMode !== "flat");
  const groupToggleTooltip = $derived(GROUP_TOOLTIPS[session.tabGroupMode]);
  // Unread mode splits into just two sections (unread / read), so each tab keeps
  // its own status glyph — the binder only marks the read/unread boundary. Status
  // mode owns the glyph on the binder instead, so tabs drop it.
  const showTabStatusInGroup = $derived(session.tabGroupMode === "unread");

  type TabSection = {
    key: string;
    label: string;
    tabIds: string[];
    visual: GroupVisual;
  };

  const groupedSections = $derived.by<TabSection[] | null>(() => {
    if (!isGrouped) return null;
    const pres =
      GROUP_PRESENTATION[session.tabGroupMode as "status" | "unread"];
    return buildTabSections(
      renderedTabIds,
      session.tabGroupMode,
      (tabId) => session.resolveTab(tabId),
      planStore.plans,
    ).map(({ key, tabIds }) => ({
      key,
      tabIds,
      label: pres.labels[key],
      visual: pres.visual[key],
    }));
  });

  function projectName(sess: Session | undefined): string {
    const dir = sess?.workingDirectory;
    if (!dir || dir === "~") return "Home";
    const parts = dir.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] || "Home";
  }

  function tabLabel(tab: Tab, sess: Session | undefined): string {
    const { title } = tab;
    if (!title || title === "Resumed Session") return projectName(sess);
    return title;
  }

  function progressPercent(sess: Session | undefined): number {
    if (!sess?.progress || sess.progress.totalSteps === 0) return 0;
    return Math.min(
      100,
      Math.max(0, (sess.progress.currentStep / sess.progress.totalSteps) * 100),
    );
  }

  function isTabComplete(sess: Session | undefined): boolean {
    return (
      !!sess?.progress &&
      sess.progress.totalSteps > 0 &&
      sess.progress.currentStep >= sess.progress.totalSteps
    );
  }

  function isSessionRunning(sess: Session | undefined): boolean {
    return sess?.status === "running" || sess?.status === "connecting";
  }

  let barEl = $state<HTMLElement | null>(null);

  // Position the seam's cut-out under the active tab so the bottom hairline
  // appears to route up and around it. Bar-level + mask = no overlap, so the
  // horizontal scroller never clips it.
  function updateActiveGap() {
    if (!barEl) return;
    const activeEl = tabScroll.el?.querySelector(
      '[aria-selected="true"]',
    ) as HTMLElement | null;
    if (!activeEl) {
      barEl.style.setProperty("--gap-start", "0px");
      barEl.style.setProperty("--gap-end", "0px");
      return;
    }
    const barRect = barEl.getBoundingClientRect();
    const r = activeEl.getBoundingClientRect();
    const start = Math.max(0, r.left - barRect.left);
    const end = Math.min(barRect.width, r.right - barRect.left);
    barEl.style.setProperty("--gap-start", `${start}px`);
    barEl.style.setProperty("--gap-end", `${end}px`);
  }

  // One controller owns scroll metrics, edge flags, wheel + paging — every
  // (rAF-throttled) measurement also refreshes the active-tab seam gap.
  const tabScroll = createTabScroll({ onMeasure: () => updateActiveGap() });

  // Flip duration for tab reorder/close, shared so the post-animation gap
  // refresh can't drift out of sync with the actual animation. Kept tight so the
  // neighbours snap into the closed tab's gap rather than drifting.
  const TAB_FLIP_MS = 150;

  // Drag-to-reorder (flat mode only — grouped order is computed, not manual).
  let dragTabId = $state<string | null>(null);
  let dragOverTabId = $state<string | null>(null);

  function onTabDragStart(e: DragEvent, tabId: string) {
    dragTabId = tabId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", tabId);
    }
  }
  function onTabDragOver(e: DragEvent, tabId: string) {
    if (!dragTabId || dragTabId === tabId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dragOverTabId = tabId;
  }
  function onTabDrop(e: DragEvent, tabId: string) {
    e.preventDefault();
    if (dragTabId && dragTabId !== tabId) session.reorderTab(dragTabId, tabId);
    dragTabId = null;
    dragOverTabId = null;
  }
  function onTabDragEnd() {
    dragTabId = null;
    dragOverTabId = null;
  }

  const popoverLayer = getPopoverLayer();
  let contextMenu = $state<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  let contextMenuEl = $state<HTMLDivElement | null>(null);

  // Capture phase: the tab bar stops mousedown propagation, so a bubble-phase
  // document listener never sees outside clicks. Capture runs before that.
  $effect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (!contextMenuEl?.contains(e.target as Node)) closeContextMenu();
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", handler, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handler, true);
    };
  });

  function openContextMenu(e: MouseEvent, tabId: string) {
    e.preventDefault();
    e.stopPropagation();
    contextMenu = { tabId, x: e.clientX, y: e.clientY };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  async function forkFromContextMenu(tabId: string) {
    closeContextMenu();
    await session.forkTab(tabId);
  }

  async function continueWorktreeFromContextMenu(tabId: string) {
    closeContextMenu();
    await session.continueInWorktree(tabId);
  }

  function closeFromContextMenu(tabId: string) {
    closeContextMenu();
    session.closeTab(tabId);
  }

  // Edge fades appear only on the side that can actually scroll, so the masked
  // edge always sits under the arrow overlay (and the strip reads as flush when
  // nothing is hidden in that direction).
  const maskImage = $derived.by(() => {
    const left = tabScroll.canLeft ? "transparent 0, #000 3.5rem" : "#000 0";
    const right = tabScroll.canRight
      ? "#000 calc(100% - 3.5rem), transparent 100%"
      : "#000 100%";
    return `linear-gradient(to right, ${left}, ${right})`;
  });

  // Keep the active tab in view + seam gap synced when the active tab, order, or
  // grouping changes. A single tick→measure pass replaces the old
  // tick→rAF→scrollIntoView→setTimeout chain.
  let lastActiveId = "";
  $effect(() => {
    const activeId = session.activeTabId;
    // Read order + grouped layout so a reorder/group-move re-runs this effect.
    renderedTabIds.join("|");
    groupedSections?.map((g) => `${g.key}:${g.tabIds.join(",")}`).join("|");
    const sc = tabScroll.el;
    if (!sc) return;
    const activeChanged = activeId !== lastActiveId;
    lastActiveId = activeId;
    void tick().then(() => {
      const activeEl = sc.querySelector(
        '[aria-selected="true"]',
      ) as HTMLElement | null;
      // Bring a freshly-selected tab into view, but don't yank the strip back
      // just because a background status change re-ran this effect mid-scroll.
      if (activeEl && (activeChanged || !tabScroll.recentlyManual())) {
        // When the active tab is the first one, scroll fully to 0 rather than
        // `inline: "nearest"` — the latter stops at the scroller's leading
        // padding (~8px), leaving canLeft true so the edge fade + left arrow
        // overlay clip the first tab. This is the wrap-around case for ⌥⇧N.
        const firstTab = sc.querySelector('[role="tab"]');
        if (activeEl === firstTab) {
          sc.scrollTo({ left: 0, behavior: activeChanged ? "smooth" : "auto" });
        } else {
          activeEl.scrollIntoView({
            behavior: activeChanged ? "smooth" : "auto",
            block: "nearest",
            inline: "nearest",
          });
        }
      }
      tabScroll.remeasure();
    });
    // A reorder/close animates via flip; re-measure once it settles so the seam
    // gap lands on the tab's final position rather than mid-flight.
    const t = setTimeout(() => tabScroll.remeasure(), TAB_FLIP_MS + 40);
    return () => clearTimeout(t);
  });
</script>

<!-- Inner content of a tab — shared by the grouped and flat layouts so the row,
     status glyph, label, close button and progress bar live in one place. The
     outer tab <div> stays per-layout because only the flat list animates/reorders. -->
{#snippet tabInner(tabId: string, showStatus: boolean)}
  {@const tab = session.tabs[tabId]}
  {@const sess = session.sessionFor(tabId)}
  {@const creatingWorktree = session.isContinuingInWorktree(tabId)}
  {@const statusIcon =
    showStatus && tab && sess ? getStatusIcon(sess.status) : null}
  {@const hasProgress =
    isSessionRunning(sess) && !!sess?.progress && sess.progress.totalSteps > 0}
  {@const pPercent = progressPercent(sess)}
  {@const pComplete = isTabComplete(sess)}
  {#if tab}
    <div class="tab-row">
      {#if creatingWorktree}
        <TreeStructureIcon
          size={10}
          data-testid="tab-status-icon"
          data-status="worktree-creating"
          style="color:var(--solus-accent);flex-shrink:0"
          class="tab-status-spin"
        />
      {:else if statusIcon}
        {@const Icon = statusIcon.component}
        <Icon
          size={10}
          data-testid="tab-status-icon"
          data-status={sess?.status}
          style="color:{statusIcon.color};flex-shrink:0"
          class={statusIcon.spin ? "tab-status-spin" : ""}
        />
      {/if}
      <span class="tab-label">{tabLabel(tab, sess)}</span>
      <button
        onclick={(e) => {
          e.stopPropagation();
          session.closeTab(tabId);
          requestInputFocus();
        }}
        class="tab-close"
        aria-label="Close tab"
        title="Close tab"
      >
        <XIcon size={11} />
      </button>
    </div>
    {#if hasProgress}
      <div class="tab-progress-track">
        <div
          class="tab-progress-fill {pComplete
            ? 'tab-progress-fill-complete'
            : ''}"
          style="width:{pPercent}%"
        ></div>
      </div>
    {/if}
  {/if}
{/snippet}

<div
  class="no-drag flex flex-col"
  class:editor-variant={variant === "editor"}
>
  <div class="tab-bar-row flex items-center" bind:this={barEl}>
    <div class="tab-seam" aria-hidden="true"></div>
    {#if showSidebarToggle}
      <button
        class="tab-chrome-lead tab-chrome-lead--left"
        onclick={() => {
          onToggleSidebar?.();
          requestInputFocus();
        }}
        aria-label="Expand sidebar"
        use:tooltip={`Expand sidebar (${comboHint("global.toggle-sidebar")})`}
      >
        <SidebarSimpleIcon size={14} />
      </button>
      <div class="tab-sep tab-sep-lead flex-shrink-0" aria-hidden="true"></div>
    {/if}

    <div class="relative min-w-0 flex-1">
      {#if tabScroll.overflowing}
        <button
          class="tab-scroll-btn tab-scroll-btn--left"
          data-active={tabScroll.canLeft}
          tabindex={tabScroll.canLeft ? 0 : -1}
          onclick={() => tabScroll.page(-1)}
          aria-label="Scroll tabs left"
        >
          <CaretLeftIcon size={9} />
        </button>
      {/if}
      <div
        class="tab-scroll-row flex items-center gap-0.5 overflow-x-auto min-w-0"
        use:tabScroll.attach
        style="scrollbar-width:none; padding-left:0.5rem; padding-right:0.875rem; mask-image:{maskImage}; -webkit-mask-image:{maskImage};"
      >
        {#if isGrouped && groupedSections}
          {#each groupedSections as group, gi (group.key)}
            {@const gv = group.visual}
            {@const GIcon = gv.icon}
            {@const count = group.tabIds.length}
            <!-- Binder divider — an index tab leading each status section: a flat
                 status-colored spine, a faint tinted body, and a rounded outer
                 edge, so the section's tabs read as hanging off the divider. The
                 status glyph lives here, so the tabs below drop their own icon. -->
            <span
              class="tab-group-binder"
              class:tab-group-lead={gi > 0}
              style="--gc:{gv.color}"
              use:tooltip={`${group.label} · ${count}`}
            >
              <GIcon
                size={13}
                weight={gv.weight ?? "regular"}
                style="color:{gv.color}"
                class={gv.spin ? "tab-status-spin" : ""}
              />
            </span>
            {#each group.tabIds as tabId (tabId)}
              {@const tab = session.tabs[tabId]}
              {@const sess = session.sessionFor(tabId)}
              {@const isActive = tabId === session.activeTabId}
              {@const attention =
                tab && sess
                  ? getAttentionState(sess, tab, planStore.plans)
                  : null}
              {@const needsAttention = !!attention && attention !== "running"}
              {@const isUnread = attention === "unread"}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                onclick={() => {
                  session.selectTab(tabId);
                  requestInputFocus();
                }}
                oncontextmenu={(e) => openContextMenu(e, tabId)}
                data-testid="tab-item"
                data-status={sess?.status ?? "idle"}
                class="tab-item {isActive ? 'active' : ''} {needsAttention
                  ? 'needs-attention'
                  : ''} {isUnread ? 'unread' : ''}"
                role="tab"
                aria-selected={isActive}
                aria-label={tab
                  ? needsAttention
                    ? `${tabLabel(tab, sess)} — ${attentionLabel(attention)}`
                    : tabLabel(tab, sess)
                  : undefined}
                title={tab
                  ? `${tabLabel(tab, sess)} — ${projectByline(sess)}`
                  : undefined}
                tabindex="0"
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    session.selectTab(tabId);
                    requestInputFocus();
                  }
                }}
              >
                {@render tabInner(tabId, showTabStatusInGroup)}
              </div>
            {/each}
          {/each}
        {:else}
          {#each renderedTabIds as tabId (tabId)}
            {@const tab = session.tabs[tabId]}
            {@const sess = session.sessionFor(tabId)}
            {@const isActive = tabId === session.activeTabId}
            {@const attention =
              tab && sess
                ? getAttentionState(sess, tab, planStore.plans)
                : null}
            {@const needsAttention = !!attention && attention !== "running"}
            {@const isUnread = attention === "unread"}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              animate:flip={{ duration: TAB_FLIP_MS }}
              in:scale={{ start: 0.92, duration: 130 }}
              out:scale={{ start: 0.96, duration: 90, easing: quintOut }}
              draggable="true"
              ondragstart={(e) => onTabDragStart(e, tabId)}
              ondragover={(e) => onTabDragOver(e, tabId)}
              ondrop={(e) => onTabDrop(e, tabId)}
              ondragend={onTabDragEnd}
              onclick={() => {
                session.selectTab(tabId);
                requestInputFocus();
              }}
              oncontextmenu={(e) => openContextMenu(e, tabId)}
              data-testid="tab-item"
              data-status={sess?.status ?? "idle"}
              class="tab-item {isActive ? 'active' : ''} {needsAttention
                ? 'needs-attention'
                : ''} {isUnread ? 'unread' : ''} {dragTabId === tabId
                ? 'dragging'
                : ''} {dragOverTabId === tabId ? 'drag-over' : ''}"
              role="tab"
              aria-selected={isActive}
              aria-label={tab
                ? needsAttention
                  ? `${tabLabel(tab, sess)} — ${attentionLabel(attention)}`
                  : tabLabel(tab, sess)
                : undefined}
              title={tab
                ? `${tabLabel(tab, sess)} — ${projectByline(sess)}`
                : undefined}
              tabindex="0"
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  session.selectTab(tabId);
                  requestInputFocus();
                }
              }}
            >
              {@render tabInner(tabId, true)}
            </div>
          {/each}
        {/if}
      </div>
      {#if tabScroll.overflowing}
        <button
          class="tab-scroll-btn tab-scroll-btn--right"
          data-active={tabScroll.canRight}
          tabindex={tabScroll.canRight ? 0 : -1}
          onclick={() => tabScroll.page(1)}
          aria-label="Scroll tabs right"
        >
          <CaretRightIcon size={9} />
        </button>
      {/if}
    </div>

    <div class="tab-sep flex-shrink-0" aria-hidden="true"></div>

    <div class="tab-actions flex items-center gap-1 flex-shrink-0 ml-1 pr-2">
      <button
        onclick={async () => {
          await session.createTab();
          requestInputFocus();
        }}
        data-testid="new-tab-button"
        class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
        use:tooltip={variant === "editor"
          ? `New session in branch (${comboHint("global.new-tab")})`
          : "New tab"}
      >
        <PlusIcon size={14} />
      </button>

      <button
        onclick={() => {
          session.toggleTabGroupMode();
          requestInputFocus();
        }}
        data-testid="tab-group-toggle"
        class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors {isGrouped
          ? 'text-(--solus-accent)'
          : 'text-(--solus-text-tertiary) hover:text-(--solus-text-primary)'}"
        use:tooltip={groupToggleTooltip}
      >
        <FunnelSimpleIcon size={13} weight={isGrouped ? "fill" : "regular"} />
      </button>

      {#if variant === "pill"}
        <button
          onclick={() =>
            window.dispatchEvent(
              new CustomEvent("solus:toggle-session-picker"),
            )}
          class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          use:tooltip={`Resume a previous session (${comboHint("global.session-picker")})`}
        >
          <ClockIcon size={13} />
        </button>

        <button
          onclick={() => session.togglePlansGallery()}
          class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          use:tooltip={"Plans (⌥⇧L)"}
        >
          <ArticleIcon size={14} />
        </button>
        <button
          onclick={() => session.toggleFolioGallery()}
          class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          use:tooltip={"Folio — documents (⌥⇧;)"}
        >
          <FileTextIcon size={14} />
        </button>
      {/if}

      {#if showPanelToggle}
        <button
          onclick={() => {
            onToggleProjectPanel?.();
            requestInputFocus();
          }}
          class="tab-chrome-lead tab-chrome-lead--right"
          aria-label="Expand project panel"
          use:tooltip={`Expand project panel (${comboHint("global.toggle-project-panel")})`}
        >
          <SidebarSimpleIcon size={13} mirrored />
        </button>
      {/if}
    </div>
  </div>
  {#if variant === "pill"}
    <div class="tab-strip-divider"></div>
  {/if}
</div>

<svelte:window
  onkeydown={(e) => {
    if (contextMenu && e.key === "Escape") closeContextMenu();
  }}
/>

{#if contextMenu && popoverLayer.el}
  {@const ctxSess = session.sessionFor(contextMenu.tabId)}
  <div
    bind:this={contextMenuEl}
    class="tab-ctx-menu"
    use:portal={popoverLayer.el}
    style="left:{contextMenu.x}px;top:{contextMenu.y}px"
    role="menu"
  >
    {#if ctxSess?.agentSessionId}
      <button
        class="tab-ctx-item"
        role="menuitem"
        onclick={() => forkFromContextMenu(contextMenu!.tabId)}
      >
        <GitForkIcon size={12} />
        <span>Fork Session</span>
        <span class="tab-ctx-kbd">⌥F</span>
      </button>
      {#if !ctxSess?.gitContext?.worktreePath}
        <button
          class="tab-ctx-item"
          role="menuitem"
          disabled={session.isContinuingInWorktree(contextMenu.tabId)}
          onclick={() => continueWorktreeFromContextMenu(contextMenu!.tabId)}
        >
          <TreeStructureIcon
            size={12}
            class={session.isContinuingInWorktree(contextMenu.tabId) ? "tab-status-spin" : ""}
          />
          <span>{session.isContinuingInWorktree(contextMenu.tabId) ? "Creating Worktree…" : "Continue in Worktree"}</span>
          {#if !session.isContinuingInWorktree(contextMenu.tabId)}
            <span class="tab-ctx-kbd">⌥W</span>
          {/if}
        </button>
      {/if}
      <div class="tab-ctx-sep"></div>
    {/if}
    <button
      class="tab-ctx-item tab-ctx-item-danger"
      role="menuitem"
      onclick={() => closeFromContextMenu(contextMenu!.tabId)}
    >
      <XIcon size={12} />
      <span>Close Tab</span>
    </button>
  </div>
{/if}
